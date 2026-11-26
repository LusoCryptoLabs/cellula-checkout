// The channel's secrets at rest: the signer's state (the channel's keys), the invoices'
// secrets and the pay link's key are kept only sealed, with AES-GCM under a key the browser makes
// once and keeps in IndexedDB as a non-extractable CryptoKey. Nothing is asked of the person for
// it. A copy of localStorage then carries ciphertext only, and code in the page cannot read the
// key out, only use it while the page is open; the passkey guards what moves money out.

import { idbGet, idbPut } from './idb.ts'

const PREFIX = 'sealed1:'
const AAD = new TextEncoder().encode('cells:fiber:vault')

export const isSealed = (stored: string) => stored.startsWith(PREFIX)

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function sealWith(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(plain)))
  return `${PREFIX}${toB64(iv)}:${toB64(ct)}`
}

/** The plain text of a stored value. One written before sealing comes back as it is, once. */
export async function openWith(key: CryptoKey, stored: string): Promise<string> {
  if (!isSealed(stored)) return stored
  const [iv = '', ct = ''] = stored.slice(PREFIX.length).split(':')
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: AAD }, key, fromB64(ct)))
  } catch {
    throw new VaultKeyLost()
  }
}

/** The sealed value cannot be opened with this browser's key: the key went with its site data. */
export class VaultKeyLost extends Error {
  constructor() {
    super("this browser no longer has the key that seals your channel here; bring it back with your passkey")
  }
}

const keys = new Map<string, Promise<CryptoKey>>()

/** This browser's sealing key in IndexedDB `dbName`, made the first time. */
export function vaultKey(dbName: string): Promise<CryptoKey> {
  let key = keys.get(dbName)
  if (!key) {
    key = (async () => {
      const kept = await idbGet<CryptoKey>(dbName, 'vault')
      if (kept) return kept
      const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await idbPut(dbName, 'vault', made)
      return made
    })()
    keys.set(dbName, key)
  }
  return key
}
