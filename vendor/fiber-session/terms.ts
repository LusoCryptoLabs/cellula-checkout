// What this browser's signer accepts for a payment to one of its invoices: the SDK checks every
// new TLC against it (fiber-lsp-sdk, commitment.rs). Fiber adds a random delay to each payment's
// expiry, in 4 hour steps, up to 14 days after the payment is sent (graph.rs,
// rand_tlc_expiry_delta, MAX_PAYMENT_TLC_EXPIRY_LIMIT). A payment can be sent until the invoice
// expires, so its TLC can expire up to 14 days after that. The signer refuses a TLC outside
// these bounds, and a refused TLC holds the channel: nothing else moves on it. With 7 days here,
// a one hour invoice took a TLC of 7.8 days on 2026-10-06 and its channel stopped.
const DAY = 86_400_000
export const MAX_TLC_EXPIRY = 14 * DAY

export type InvoiceTerms = {
  payment_hash: string
  hash_algorithm: 'ckb_hash'
  inbound: true
  amount: number
  expires_at_ms: number
  min_tlc_expiry_delta_ms: number
  max_tlc_expiry_ms: number
}

/** `finalMs`: the invoice's final expiry delta, a day unless the channel's delay asks for more (delay.ts). */
export function invoiceTerms(paymentHash: string, amount: bigint, now: number, valid: number, finalMs = DAY): InvoiceTerms {
  return {
    payment_hash: paymentHash,
    hash_algorithm: 'ckb_hash',
    inbound: true,
    amount: Number(amount),
    expires_at_ms: now + valid,
    // The invoice asks for this long to settle in (its final_expiry_delta).
    min_tlc_expiry_delta_ms: finalMs,
    max_tlc_expiry_ms: now + valid + MAX_TLC_EXPIRY,
  }
}
