// HTTP 402 over Fiber, as x402 v2 carries it (coinbase/x402, specs/transports-v2/http.md), with the
// "exact" scheme Fiber's own facilitator proposes (nervosnetwork/fiber#1301, not merged): the seller
// answers 402 with a Fiber invoice, the buyer pays it and asks again with that invoice and its
// preimage, the secret only a payer gets. The facilitator proposal leaves open how the invoice
// reaches the buyer: here it rides in the requirement's `extra.invoice`.
//
//   seller  paywall(merchant, {price_ckb, payTo})  -> answers 402, or lets a paid request through
//   buyer   fetchPaid(url, init, pay)              -> pays a 402 and asks again

import { createHash } from 'node:crypto'
import { ccc } from '@ckb-ccc/core'
import type http from 'node:http'
import { ckbOf, shannonsOf } from './amount.ts'
import { MerchantError } from './errors.ts'
import type { Merchant } from './merchant.ts'
import { JsonFile } from './store.ts'

export const X402_VERSION = 2
export const SCHEME = 'exact'
export const FIBER_TESTNET = 'fiber:testnet'
export const ASSET_CKB = 'ckb'

export type Requirements = {
  scheme: string
  network: string
  asset: string
  /** Shannons, as a decimal string: the invoice's own amount. */
  amount: string
  /** The invoice's payee, hex public key: for a hosted shop, its LSP's node. */
  payTo: string
  maxTimeoutSeconds: number
  extra: { invoice?: string } & Record<string, unknown>
}

export type Resource = { url: string; description?: string; mimeType?: string }
export type PaymentRequired = { x402Version: number; error?: string; resource: Resource; accepts: Requirements[] }
export type PaymentPayload = { x402Version: number; resource?: Resource; accepted: Requirements; payload: { invoice?: string; paymentPreimage?: string; payment_preimage?: string } }
export type SettlementResponse = { success: boolean; transaction: string; network: string; amount?: string; errorReason?: string }

export const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')

/** The payment hash a paywall let through, from the PAYMENT-RESPONSE it set on the answer. */
export function receiptOf(res: http.ServerResponse): string | null {
  const settled = decode<SettlementResponse>(String(res.getHeader('PAYMENT-RESPONSE') ?? ''))
  return settled?.success && settled.transaction.startsWith('fiber-receipt:') ? settled.transaction.slice('fiber-receipt:'.length) : null
}
export function decode<T>(header: string | null | undefined): T | null {
  if (!header) return null
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T
  } catch {
    return null
  }
}

/** A preimage's payment hash, by CKB's blake2b (Fiber's default) or sha256. */
function hashesOf(preimage: string): string[] {
  const bytes = Buffer.from(preimage.replace(/^0x/, ''), 'hex')
  return [ccc.hashCkb(bytes), `0x${createHash('sha256').update(bytes).digest('hex')}`]
}

export type PaywallOptions = {
  price_ckb: string | number
  /** The invoice's payee as x402 names it: the LSP's node key for a shop hosted there. */
  payTo: string
  network?: string
  description?: string
  mimeType?: string
  /** The public origin the route is reached at (https://api.example.com), behind a proxy; the
   * request's own Host otherwise. */
  baseUrl?: string
  /** How long its invoice can be paid, in minutes (10 unless told). */
  valid_minutes?: number
  /** Receipts already used, one request each: shared by every paywall of one shop, so one receipt
   * never opens two routes. */
  receipts: Receipts
  /** How long a receipt waits for the shop's own word that it is paid (5 s unless told). */
  paidWaitMs?: number
}

type Used = { used: string[] }

/** The payment hashes whose receipts opened a request (JSON). */
export class Receipts {
  private db: JsonFile<Used>
  private set: Set<string>
  constructor(file: string) {
    this.db = new JsonFile<Used>(file, () => ({ used: [] }))
    this.set = new Set(this.db.value.used)
  }

  has(paymentHash: string): boolean {
    return this.set.has(paymentHash)
  }

  /** False when it was used already. */
  async use(paymentHash: string): Promise<boolean> {
    if (this.set.has(paymentHash)) return false
    this.set.add(paymentHash)
    this.db.value.used = [...this.set]
    await this.db.save()
    return true
  }

  /** Good again: the route it opened could not answer, so the buyer asks again with it. */
  async release(paymentHash: string): Promise<void> {
    if (!this.set.delete(paymentHash)) return
    this.db.value.used = [...this.set]
    await this.db.save()
  }
}

export type Paywall = ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>) & {
  /** The check alone: whether a PAYMENT-SIGNATURE header pays this paywall, and its payment hash. */
  verify(header: string | undefined): Promise<{ ok: true; paymentHash: string } | { ok: false; reason: string }>
}

/** A gate in front of a route: true when the request carries a receipt for an invoice this shop made
 * at this price, paid in its channel and not used before (the route then answers it); otherwise it
 * answers 402 with a new invoice and returns false. A receipt is good for one request. */
export function paywall(m: Merchant, o: PaywallOptions): Paywall {
  const price = shannonsOf(o.price_ckb)
  const network = o.network ?? FIBER_TESTNET
  const requirements = (invoice: string): Requirements => ({ scheme: SCHEME, network, asset: ASSET_CKB, amount: price.toString(), payTo: o.payTo, maxTimeoutSeconds: (o.valid_minutes ?? 10) * 60, extra: { invoice } })

  const verify = async (header: string | undefined): Promise<{ ok: true; paymentHash: string } | { ok: false; reason: string }> => {
    const p = decode<PaymentPayload>(header)
    if (!p || p.x402Version !== X402_VERSION || !p.accepted || !p.payload) return { ok: false, reason: 'invalid_payload' }
    const a = p.accepted
    if (a.scheme !== SCHEME) return { ok: false, reason: 'unsupported_scheme' }
    if (a.network !== network) return { ok: false, reason: 'unsupported_network' }
    if (a.asset !== ASSET_CKB) return { ok: false, reason: 'asset_mismatch' }
    if (a.payTo !== o.payTo) return { ok: false, reason: 'pay_to_mismatch' }
    if (a.amount !== price.toString()) return { ok: false, reason: 'amount_mismatch' }
    const preimage = p.payload.paymentPreimage ?? p.payload.payment_preimage ?? ''
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(preimage)) return { ok: false, reason: 'invalid_preimage' }
    // The preimage names the invoice: only this shop's own, at this price, counts.
    const inv = hashesOf(preimage).map((h) => m.get(h)).find((i) => !!i)
    if (!inv || inv.invoice !== p.payload.invoice) return { ok: false, reason: 'invoice_unknown' }
    if (inv.amount_shannons !== price.toString()) return { ok: false, reason: 'amount_mismatch' }
    if (o.receipts.has(inv.payment_hash)) return { ok: false, reason: 'receipt_used' }
    if (inv.status !== 'paid') {
      // The payer has the secret only once this shop's signer released it; its own record of that
      // may follow a moment later.
      try {
        await m.waitPaid(inv.payment_hash, { timeoutMs: o.paidWaitMs ?? 5_000 })
      } catch {
        return { ok: false, reason: 'not_paid' }
      }
    }
    return { ok: true, paymentHash: inv.payment_hash }
  }

  const gate = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = o.baseUrl ? new URL(req.url ?? '/', o.baseUrl).href : `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
    const resource: Resource = { url, ...(o.description ? { description: o.description } : {}), ...(o.mimeType ? { mimeType: o.mimeType } : {}) }
    const header = req.headers['payment-signature']
    const given = Array.isArray(header) ? header[0] : header
    if (given) {
      const v = await verify(given)
      // Marked used before the route runs: two requests with one receipt open it once.
      if (v.ok && (await o.receipts.use(v.paymentHash))) {
        const settled: SettlementResponse = { success: true, transaction: `fiber-receipt:${v.paymentHash}`, network, amount: price.toString() }
        res.setHeader('PAYMENT-RESPONSE', encode(settled))
        return true
      }
      const refused: SettlementResponse = { success: false, errorReason: v.ok ? 'receipt_used' : v.reason, transaction: '', network }
      res.setHeader('PAYMENT-RESPONSE', encode(refused))
    }
    let required: PaymentRequired
    try {
      const inv = await m.createInvoice({ amount_ckb: ckbOf(price), memo: o.description ?? 'API request', valid_minutes: o.valid_minutes ?? 10 })
      required = { x402Version: X402_VERSION, error: given ? 'that payment does not pay for this request' : 'PAYMENT-SIGNATURE header is required', resource, accepts: [requirements(inv.invoice)] }
    } catch (e) {
      const status = e instanceof MerchantError ? e.status : 503
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: { code: e instanceof MerchantError ? e.code : 'not_ready', message: e instanceof Error ? e.message : String(e) } }))
      return false
    }
    res.writeHead(402, { 'content-type': 'application/json', 'cache-control': 'no-store', 'PAYMENT-REQUIRED': encode(required) })
    res.end(JSON.stringify(required))
    return false
  }
  return Object.assign(gate, { verify })
}

/** What a buyer needs to pay: the invoice paid, with its receipt. */
export type PayInvoice = (invoice: string, maxCkb: string | null) => Promise<{ payment_hash: string; amount_ckb: string; preimage: string | null; status: string }>

export type PaidFetch = {
  response: Response
  /** The payment made for it, if the seller asked one. */
  paid: { payment_hash: string; amount_ckb: string; preimage: string } | null
}

/** fetch() that pays a seller's 402 once, in Fiber on `network`, up to `max_ckb`, and asks again
 * with the receipt. A 402 it cannot pay (another network or asset, no invoice, over the limit)
 * is refused with not_payable or over_cap, and nothing is paid. */
export async function fetchPaid(url: string, init: RequestInit, pay: PayInvoice, o: { max_ckb?: string | number | null; network?: string; fetch?: typeof fetch } = {}): Promise<PaidFetch> {
  const f = o.fetch ?? fetch
  const network = o.network ?? FIBER_TESTNET
  const first = await f(url, init)
  if (first.status !== 402) return { response: first, paid: null }
  const required = decode<PaymentRequired>(first.headers.get('payment-required')) ?? ((await first.json().catch(() => null)) as PaymentRequired | null)
  const offer = required?.accepts?.find((a) => a.scheme === SCHEME && a.network === network && a.asset === ASSET_CKB && typeof a.extra?.invoice === 'string')
  if (!required || !offer) throw new MerchantError('not_payable', `the seller asks a payment this agent cannot make (wants ${required?.accepts?.map((a) => `${a.scheme} on ${a.network}`).join(', ') || 'nothing readable'})`, 422)
  if (!/^\d+$/.test(offer.amount)) throw new MerchantError('not_payable', 'the seller names no amount in shannons', 422)
  const amount = BigInt(offer.amount)
  const max = o.max_ckb == null ? null : shannonsOf(o.max_ckb)
  if (max !== null && amount > max) throw new MerchantError('over_cap', `the seller asks ${ckbOf(amount)} CKB, more than the ${ckbOf(max)} allowed for this request`, 422)
  const p = await pay(offer.extra.invoice!, ckbOf(amount))
  // The invoice must ask what the requirement says, or the agent paid something else.
  if (p.amount_ckb !== ckbOf(amount)) throw new MerchantError('not_payable', `the invoice asked ${p.amount_ckb} CKB, not the ${ckbOf(amount)} the seller named`, 422)
  if (p.status !== 'paid' || !p.preimage) throw new MerchantError('payment_failed', `the payment is ${p.status}: ask again once it has ended (${p.payment_hash})`, 502)
  const payload: PaymentPayload = { x402Version: X402_VERSION, resource: required.resource, accepted: offer, payload: { invoice: offer.extra.invoice!, paymentPreimage: p.preimage } }
  const headers = new Headers(init.headers)
  headers.set('PAYMENT-SIGNATURE', encode(payload))
  const paid = { payment_hash: p.payment_hash, amount_ckb: p.amount_ckb, preimage: p.preimage }
  // Paid already: a request with the receipt that never reached the seller is sent again with the
  // same receipt, nothing paid again; and if it never does, what was paid is said.
  for (let attempt = 1; ; attempt++) {
    try {
      return { response: await f(url, { ...init, headers }), paid }
    } catch (e) {
      if (attempt >= PAID_TRIES) {
        const why = e instanceof MerchantError ? e.message : 'no answer'
        throw new MerchantError('unreachable', `paid ${paid.amount_ckb} CKB (${paid.payment_hash}, receipt ${paid.preimage}), but the request that carries the receipt did not reach the seller after ${PAID_TRIES} tries (${why}): asking again from the start pays again`, 502)
      }
      await new Promise((r) => setTimeout(r, PAID_RETRY_MS * attempt))
    }
  }
}

/** The request that carries a receipt: tried this often, this far apart (times the try). */
const PAID_TRIES = 3
const PAID_RETRY_MS = 1_000
