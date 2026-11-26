// The channel signer's state, kept encrypted by the LSP's gateway so another browser can take
// over. The key comes from a passkey's PRF output and never leaves the browser: it is derived
// when the passkey is made, kept as a non-extractable CryptoKey in IndexedDB, and derived again
// from the same passkey elsewhere, where the passkey's user handle names the tenant. The gateway
// keeps only ciphertext, with versions that only go up, and hands it out only with an access code
// derived from the same passkey, of which it keeps the hash. Whoever keeps it could
// still hand a new browser an old version, which could then sign a commitment twice. Where the
// passkey has largeBlob, each use of it also writes the newest version into the passkey, and a new
// browser refuses a copy older than that; a copy newer than the last use
// of the passkey still rests on the gateway's word.

import type { Keeper } from './host.ts'
import { idbGet, idbPut } from './idb.ts'

const text = new TextEncoder()

const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => new Uint8Array((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)))
function toB64(b: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(b)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export type Unlocked = { key: CryptoKey; access: string }
export type Sealed = { iv: string; ciphertext: string }

/** What the gateway keeps of an access code: its SHA-256, so its copy cannot be used as one. */
export const accessHash = async (access: string) => toHex(await crypto.subtle.digest('SHA-256', fromHex(access)))

export type KeeperOptions = {
  /** Salt of the keys and part of every sealed copy: a passkey made under one label opens
   * nothing under another. */
  label: string
  /** The passkey's relying party name and how the passkey is listed. */
  rpName: string
  /** The relying party's id, when it is not this page's own host: a parent domain, so the same
   * passkey opens the keys on every host under it (a wallet on its own subdomain).
   * Left out, the browser uses this page's host. */
  rpId?: string
  userName: (tenantId: string) => string
  displayName: string
  /** IndexedDB database holding the keys (the vault's key lives there too). */
  db?: string
}

// WebAuthn's PRF and largeBlob extensions are newer than some DOM typings; read them loosely.
type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }; largeBlob?: { supported?: boolean; blob?: ArrayBuffer; written?: boolean } }

/** What a passkey keeps of a channel's backups (WebAuthn largeBlob): the newest version it saw, for
 * a device with nothing else to compare a copy from the gateway with. The
 * gateway cannot write it; only the passkey's owner, using it, can. */
export function versionMark(label: string, tenantId: string, version: number): Uint8Array {
  return text.encode(JSON.stringify({ [label]: { tenant: tenantId, version } }))
}

/** The version a passkey's blob keeps for this tenant under `label`; undefined when it keeps none. */
export function markedVersion(label: string, tenantId: string, blob?: ArrayBuffer | Uint8Array): number | undefined {
  if (!blob) return undefined
  try {
    const kept = JSON.parse(new TextDecoder().decode(blob))?.[label]
    return kept?.tenant === tenantId && Number.isSafeInteger(kept.version) && kept.version >= 0 ? kept.version : undefined
  } catch {
    return undefined
  }
}

/** The largeBlob request of one use: write `mark` when given, else read what is kept. */
export const largeBlobInput = (mark?: Uint8Array) => ({ largeBlob: mark ? { write: mark } : { read: true } })

/** Passkey backups for a browser. */
export function browserKeeper(options: KeeperOptions): Keeper {
  const { label } = options
  const dbName = options.db ?? 'cells-fiber'
  const prfInput = () => ({ prf: { eval: { first: text.encode(label) } } }) as AuthenticationExtensionsClientInputs
  // The tenant and the version are bound into the encryption, so a stored copy cannot be passed
  // off as another tenant's or another version's.
  const aad = (tenantId: string, version: number) => text.encode(`${label}:${tenantId}:${version}`)

  async function derive(prf: BufferSource, tenantId: string): Promise<Unlocked> {
    const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey', 'deriveBits'])
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: text.encode(label), info: text.encode(tenantId) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    // A second value from the same passkey, under another label: the access code. It says nothing
    // about the key, and only someone who used the passkey can work it out.
    const access = toHex(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: text.encode(label), info: text.encode(`access:${tenantId}`) }, base, 256))
    await idbPut(dbName, 'backup', key)
    await idbPut(dbName, 'access', access)
    return { key, access }
  }

  return {
    /** Make a passkey for this tenant on this site, and the backup key and access code from it. */
    async create(tenantId) {
      const created = (await navigator.credentials.create({
        publicKey: {
          rp: { name: options.rpName, ...(options.rpId ? { id: options.rpId } : {}) },
          user: { id: fromHex(tenantId), name: options.userName(tenantId), displayName: options.displayName },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          // largeBlob where the passkey has it: it keeps the newest backup version.
          extensions: { ...prfInput(), largeBlob: { support: 'preferred' } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null
      if (!created) throw new Error('no passkey was made')
      await idbPut(dbName, 'credential', toHex(created.rawId))
      const made = created.getClientExtensionResults() as PrfResults
      let prf = made.prf?.results?.first
      if (!prf) {
        if (made.prf?.enabled === false) throw new Error('this passkey cannot give a key (no PRF), so it cannot keep a backup')
        // Some authenticators only evaluate the PRF when the passkey is used, not when it is made.
        const used = (await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ type: 'public-key', id: created.rawId }],
            userVerification: 'required',
            extensions: prfInput(),
            ...(options.rpId ? { rpId: options.rpId } : {}),
          },
        })) as PublicKeyCredential | null
        prf = (used?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first
      }
      if (!prf) throw new Error('this passkey cannot give a key (no PRF), so it cannot keep a backup')
      return derive(prf, tenantId)
    },

    /** Use a passkey made here before: which tenant it belongs to, the backup key and access code.
     * With `mark` (and the channel `expected`), the passkey also keeps that backup version, when it
     * was made here and has largeBlob; without, what it keeps comes back as `seen`. */
    async unlock(expected, mark) {
      // A write names the passkey: only the one made here, for this channel.
      const credential = expected && mark !== undefined ? await idbGet<string>(dbName, 'credential').catch(() => undefined) : undefined
      const writing = credential ? versionMark(label, expected!, mark!) : undefined
      const used = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          userVerification: 'required',
          ...(credential ? { allowCredentials: [{ type: 'public-key', id: fromHex(credential) }] } : {}),
          extensions: { ...prfInput(), ...largeBlobInput(writing) } as AuthenticationExtensionsClientInputs,
          ...(options.rpId ? { rpId: options.rpId } : {}),
        },
      })) as PublicKeyCredential | null
      if (!used) throw new Error('no passkey was used')
      const handle = (used.response as AuthenticatorAssertionResponse).userHandle
      const results = used.getClientExtensionResults() as PrfResults
      const prf = results.prf?.results?.first
      if (!handle) throw new Error('this passkey does not name a channel')
      if (!prf) throw new Error('this passkey cannot give a key (no PRF)')
      const tenantId = toHex(handle)
      // Another channel's passkey keeps nothing here: the key and code kept are this channel's.
      if (expected && tenantId !== expected) throw new Error('that passkey keeps another channel')
      const seen = writing ? undefined : markedVersion(label, tenantId, results.largeBlob?.blob)
      // The passkey used here is the one later marks are written with.
      await idbPut(dbName, 'credential', toHex(used.rawId))
      return { tenantId, seen, ...(await derive(prf, tenantId)) }
    },

    /** The key and access code kept here; no access code for a channel kept before them. */
    async stored() {
      return { key: await idbGet<CryptoKey>(dbName, 'backup'), access: await idbGet<string>(dbName, 'access') }
    },

    async seal(key, tenantId, version, state) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(tenantId, version) }, key, text.encode(state))
      return { iv: toB64(iv), ciphertext: toB64(ciphertext) }
    },

    async open(key, tenantId, version, sealed) {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: aad(tenantId, version) }, key, fromB64(sealed.ciphertext))
      return new TextDecoder().decode(plain)
    },
  }
}
