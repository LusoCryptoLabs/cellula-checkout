// One kind of error with a code a shop can branch on and the HTTP status the API answers with.

export type MerchantErrorCode =
  | 'invalid_amount'
  | 'invalid_request'
  | 'not_ready'
  | 'too_large'
  | 'order_paid'
  | 'not_found'
  | 'expired'
  | 'timeout'
  | 'unauthorized'
  // Renting room (room.ts): not set up here, refused by the LSP, or a move under way.
  | 'no_room'
  | 'rent_failed'
  | 'busy'
  // An agent paying (agent.ts, x402.ts): past a cap the person set, an invoice it cannot read, a
  // payment that did not go, or a seller's 402 it cannot pay. A URL it will not fetch (on this
  // machine or its network) or cannot reach (public-fetch.ts).
  | 'over_cap'
  | 'invalid_invoice'
  | 'payment_failed'
  | 'not_payable'
  | 'not_public'
  | 'unreachable'
  // What the person set (agent.ts): a seller or payee not allowed, a payment waiting for their
  // approval or refused by them, every payment stopped.
  | 'not_allowed'
  | 'needs_approval'
  | 'refused_by_person'
  | 'paused'
  // A seller paid over plain HTTP, a second payment for a request already on its way, or more asks
  // than the person has decided (agent-http.ts, agent.ts).
  | 'https_only'
  | 'payment_pending'
  | 'too_many_waiting'

export class MerchantError extends Error {
  code: MerchantErrorCode
  status: number
  constructor(code: MerchantErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'MerchantError'
    this.code = code
    this.status = status
  }
}
