// A recovery file: a channel's signer state and its invoices' preimages, sealed with a passphrase
// the person chooses (2026-10-13: a passkey opens only on the site that made it, and this
// file must open with any copy of the recovery page, wherever it is hosted). PBKDF2-SHA256 makes
// the key, AES-GCM-256 seals; the header (format, network, channel, date) is in the clear and
// bound to the ciphertext as its additional data, so it cannot be changed unseen.

/** Where a token's code is, as the signer's setTokens takes it. */
export type TokenCode = { code_hash: string; hash_type: string; cell_dep: unknown }
/** What a recovery file holds once opened. `state`: the signer's saved state, root key included.
 * `preimages`: payment hash to preimage, for payments held for this channel. `tokens`: where the code
 * of the channel's token is, for any token but RUSD (since 2026-10-29; absent from older files). */
export type RecoveryContent = { state: string; preimages: Record<string, string>; tokens?: TokenCode[] }
/** What a recovery file says of itself without the passphrase. */
export type RecoveryHeader = { format: 'cellula-fiber-recovery'; v: 1; network: string; channel_id: string; created_at: number }
type Sealed = RecoveryHeader & { kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }; iv: string; data: string }

const ITERATIONS = 600_000
export const MIN_PASSPHRASE = 10

function toB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const header = (h: RecoveryHeader) => new TextEncoder().encode(JSON.stringify([h.format, h.v, h.network, h.channel_id, h.created_at]))

async function keyOf(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Seal `content` with `passphrase`: the file's text, JSON. */
export async function sealRecoveryFile(content: RecoveryContent, passphrase: string, about: { network: string; channelId: string; now?: number }): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const h: RecoveryHeader = { format: 'cellula-fiber-recovery', v: 1, network: about.network, channel_id: about.channelId, created_at: about.now ?? Date.now() }
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header(h) }, await keyOf(passphrase, salt, ITERATIONS), new TextEncoder().encode(JSON.stringify(content)))
  const sealed: Sealed = { ...h, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) }, iv: toB64(iv), data: toB64(new Uint8Array(data)) }
  return JSON.stringify(sealed, null, 1)
}

/** What a file says of itself, before the passphrase: refused if it is not a recovery file. */
export function readRecoveryHeader(text: string): RecoveryHeader {
  let f: Partial<Sealed>
  try {
    f = JSON.parse(text)
  } catch {
    throw new Error('This is not a recovery file.')
  }
  if (f.format !== 'cellula-fiber-recovery' || f.v !== 1 || typeof f.channel_id !== 'string' || typeof f.network !== 'string' || typeof f.created_at !== 'number')
    throw new Error('This is not a recovery file this page can read.')
  return { format: f.format, v: f.v, network: f.network, channel_id: f.channel_id, created_at: f.created_at }
}

/** Open a recovery file with its passphrase. A wrong passphrase, or a file changed in any way,
 * opens nothing. */
export async function openRecoveryFile(text: string, passphrase: string): Promise<{ header: RecoveryHeader; content: RecoveryContent }> {
  const h = readRecoveryHeader(text)
  const f = JSON.parse(text) as Sealed
  if (f.kdf?.name !== 'PBKDF2' || f.kdf.hash !== 'SHA-256' || !(f.kdf.iterations >= ITERATIONS)) throw new Error('This recovery file is sealed in a way this page does not take.')
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(f.iv), additionalData: header(h) }, await keyOf(passphrase, fromB64(f.kdf.salt), f.kdf.iterations), fromB64(f.data))
  } catch {
    throw new Error('That passphrase does not open this file, or the file was changed.')
  }
  const content = JSON.parse(new TextDecoder().decode(plain)) as RecoveryContent
  if (typeof content.state !== 'string' || typeof content.preimages !== 'object') throw new Error('This recovery file holds nothing this page can use.')
  return { header: h, content }
}

// A backup holds the signer's state and the preimages of the invoices still in play, so a copy
// restored elsewhere can claim a payment held for it in a closed channel. One kept
// before 2026-10-13 is the state alone, and still reads. `brought`: written by a copy brought from
// its backup, whose signer was marked restored, so a device that catches up from it is only closed too
// (a tester's phone paid from such a copy and the payment stuck, 2026-10-30).
const BACKUP_FORMAT = 'cellula-backup-2'
export const packBackup = (state: string, preimages: Record<string, string>, brought = false) =>
  JSON.stringify({ format: BACKUP_FORMAT, state, preimages, ...(brought ? { brought: true } : {}) })
export function unpackBackup(text: string): { state: string; preimages: Record<string, string>; brought: boolean } {
  try {
    const o = JSON.parse(text)
    if (o?.format === BACKUP_FORMAT && typeof o.state === 'string') return { state: o.state, preimages: o.preimages ?? {}, brought: o.brought === true }
  } catch {}
  return { state: text, preimages: {}, brought: false }
}
