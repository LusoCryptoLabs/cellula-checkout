// What a session needs from where it runs. The browser (browser.ts) keeps the channel in
// localStorage, sealed, holds a Web Lock so one tab signs, and says when the page goes away; a
// server (node.ts) keeps a file and is always there. The session above it is the same code.

import type { Sealed, Unlocked } from './keeper.ts'

/** Values kept by name. `sealed` ones hold the channel's keys or secrets: a host that can seal
 * them at rest does, and opens them again on `get` (sealing one kept before sealing). */
export type Store = {
  get(name: string, opts?: { sealed?: boolean }): Promise<string | undefined>
  set(name: string, value: string, opts?: { sealed?: boolean }): Promise<void>
  remove(name: string): Promise<void>
  /** The value under another name, as it is kept (still sealed); nothing if there was none. */
  move(from: string, to: string): Promise<void>
  /** The names that start with `prefix`. */
  names(prefix: string): Promise<string[]>
}

/** Whether the signer is there to answer. Away, the session says bye, so the LSP holds payments
 * for it instead of sending them to a signer that cannot answer. */
export type Presence = {
  /** `gone`: the signer stops (the page is closed). `hidden`: it may come back. */
  onAway(fn: (why: 'gone' | 'hidden') => void): void
  /** `restored`: a page brought back from the cache. `visible`: shown again. */
  onBack(fn: (why: 'restored' | 'visible') => void): void
  visible(): boolean
  /** A last message that must leave even as the host goes away. */
  beacon(url: string, body: string): void
  /** Keep the screen on while payments arrive, where the host has one. */
  holdScreen(on: boolean): Promise<void>
}

/** Keeps the signer's state with the gateway under a key from a passkey, so another browser can
 * take over. Only a browser has one. */
export type Keeper = {
  /** Made after the wallet signs the funding, not before: a keeper whose key comes from the passkey
   * that signs can give it in the same ask, so a top-up asks the passkey once. A keeper that makes
   * a passkey of its own needs the tap that started the opening, and says nothing here. */
  afterSign?: boolean
  create(tenantId: string): Promise<Unlocked>
  /** `expected`: the channel the caller wants; another one is refused before anything is kept.
   * `mark`: a backup version for the passkey itself to keep, where it can (WebAuthn largeBlob), out
   * of the gateway's reach; without one, `seen` is the version the passkey keeps, if any. */
  unlock(expected?: string, mark?: number): Promise<Unlocked & { tenantId: string; seen?: number }>
  /** The key and access code kept here from the last passkey use, if any. */
  stored(): Promise<Partial<Unlocked>>
  seal(key: CryptoKey, tenantId: string, version: number, state: string): Promise<Sealed>
  open(key: CryptoKey, tenantId: string, version: number, sealed: Sealed): Promise<string>
}

export type Held = { held: true; release(): void } | { held: false; why: 'taken' | 'unsupported' }

/** The wasm signer's init, as wasm-bindgen's web build exports it. */
export type SignerInit = (input?: { module_or_path: BufferSource }) => Promise<unknown>

export type Host = {
  store: Store
  presence: Presence
  /** Hold `name` for as long as the host lives, so only one signer of this channel runs here. */
  acquire(name: string): Promise<Held>
  /** Hold `name` once whoever holds it lets go (the tab that had it closes). A host that cannot
   * wait leaves it out, and a session started where another signer runs stays where it is. */
  wait?(name: string): Promise<Held>
  /** Start over from what is kept (after a restore, a catch-up or a new channel). */
  restart(): void
  /** Load the signer's wasm: a browser fetches it beside the script, a server reads the file. */
  initSigner(init: SignerInit): Promise<void>
  keeper?: Keeper
  /** Keep what a watcher needs to take the cell of a commitment the LSP revoked, should the LSP
   * send one on chain while this page is closed (docs/WATCHTOWER.md): the signer's `watchRecords`,
   * JSON, nothing secret in it. Given at start and again whenever it changed. A host with no
   * watcher leaves it out. */
  watch?(channelId: string, records: string): void | Promise<void>
}
