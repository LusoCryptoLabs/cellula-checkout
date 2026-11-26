/* The interface of the channel signer that the session loads from this folder. Only the types are
 * here: the signer itself (cellula_lsp_signer.js, its wasm-bindgen glue, and
 * cellula_lsp_signer_bg.wasm) is not part of this repository. See ../VENDORED.md. */

/** The tenant's signer. Every method resolves to JSON text. */
export class LspSigner {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  authorizeCancellation(channel_id: string, payment_hash: string): Promise<any>
  authorizeClose(channel_id: string, local_script: string, remote_script: string, local_fee_rate: number, remote_fee_rate: number): Promise<any>
  authorizeFulfillment(channel_id: string, payment_hash: string, preimage: string): Promise<any>
  authorizeInvoice(channel_id: string, terms: string, preimage: string): Promise<any>
  authorizeOpenInvoice(channel_id: string, terms: string, least: string, preimage: string): Promise<any>
  authorizePayment(channel_id: string, terms: string): Promise<any>
  authorizeWatchtower(channel_id: string, destination: string, max_fee: number): Promise<any>
  claimNext(channel_id: string, destination: string, preimages: string, helper: string): Promise<any>
  /** After the delay, pay the tenant's share to `destination` (a script, JSON). */
  claimShareNow(channel_id: string, destination: string, preimages: string, helper: string): Promise<any>
  configureChain(): Promise<any>
  /** Come back from `saved` (what `host.save` was last given), or make a new root key. */
  static create(host: any, saved?: string | null): Promise<LspSigner>
  isRestored(channel_id: string): Promise<any>
  /** The store came back from a copy: its channels are only closed from now on. */
  markRestored(): Promise<any>
  openChannel(request: string): Promise<any>
  openInvoice(payment_hash: string): Promise<any>
  openingRequest(): Promise<any>
  poll(): Promise<any>
  /** Close on chain with the latest commitment, nothing asked of the LSP. */
  publishCommitment(channel_id: string): Promise<any>
  /** Where the money stands for leaving without the LSP. */
  recoveryStatus(channel_id: string, destination: string, preimages: string): Promise<any>
  /** Register at the LSP whose node id the page gives (hex, 33 bytes). */
  register(lsp_node_id: string): Promise<any>
  releasePreimage(channel_id: string, payment_hash: string, preimage: string, target: string): Promise<any>
  /** Renew the tenant token when it ends within a week, or now with `force`; resolves to
   * `{ "renewed", "expires_at_ms" }`. */
  renew(lsp_node_id: string, force: boolean): Promise<any>
  /** Where each token's code cell is, as the gateway says it. */
  setTokens(tokens: string): Promise<any>
  status(): Promise<any>
  watchRecords(channel_id: string): Promise<any>
}

/** What the page needs to know about an invoice before it lets the signer pay it, read here so
 * that no server's reading is trusted. */
export function parseInvoice(invoice: string): string

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module
export type SyncInitInput = BufferSource | WebAssembly.Module

/** Instantiates the module from `module_or_path`, or from the wasm beside the glue. */
export default function __wbg_init(module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<unknown>
/** Instantiates the module from bytes, synchronously. */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): unknown
