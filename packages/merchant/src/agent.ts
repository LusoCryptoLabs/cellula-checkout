// An agent's side of Fiber payments: its own Fiber balance, opened from its own key on the machine
// it runs on, paying invoices (and sellers' HTTP 402 answers, x402.ts) by itself, within caps the
// person sets. The caps are checked before the signer is asked; the channel itself never holds more
// than was put in, so the most an agent can spend is its balance. What the agent is told to do (by
// a model, over MCP) never chooses where its money goes back to: that address is the person's,
// fixed when the agent starts (takeOut).
//
// Beside the caps, the person can set when starting it: the most in any 24 hours, the sellers and
// payees it may pay, and an amount above which a payment waits for their approval on the agent's
// approvals page, where they can also stop every payment. None of it can be changed over the API.

import { randomBytes } from 'node:crypto'
import { ckbOf, shannonsOf } from './amount.ts'
import { MerchantError } from './errors.ts'
import { JsonFile } from './store.ts'

/** What an agent needs of a Fiber session; FiberSession on a server does all of it. */
export interface PayerSession {
  start(): Promise<void>
  /** What an invoice says, read by the signer itself. */
  parseInvoice(invoice: string): { payment_hash: string; amount: string | null; currency: string; expired: boolean; payee?: string | null }
  /** Hands the payment to the signer and the LSP; resolves with its payment hash. */
  pay(invoice: string): Promise<string>
  /** True once the payee's secret is here, false once the payment failed. */
  whenSent(paymentHash: string): Promise<boolean>
  sentPayment(paymentHash: string): Promise<{ status: string; preimage?: string } | undefined>
  close(): Promise<void>
  readonly state: { channelId?: string | null; channel: { ready: boolean; closed: boolean; local: bigint; remote: bigint } | null; feeDue?: bigint; closing?: boolean }
}

export type PaymentStatus = 'sending' | 'paid' | 'failed'

export type Payment = {
  payment_hash: string
  /** The invoice paid, as given. */
  invoice: string
  amount_ckb: string
  amount_shannons: string
  memo: string
  /** sending: with the signer and the LSP, no answer yet; paid: the payee's secret is here; failed:
   * nothing left the balance. */
  status: PaymentStatus
  /** The payee's secret, hex: the receipt a seller asks for (x402.ts). */
  preimage: string | null
  error: string | null
  /** Milliseconds since 1970, as Date.now(). */
  created_at: number
  settled_at: number | null
}

/** Set by the person when the agent starts, never over the API. Absent: no cap but the balance. */
export type AgentCaps = {
  per_payment_ckb?: string | number
  total_ckb?: string | number
  /** The most in any 24 hours: counted back from each new payment, not reset at a set hour. */
  day_ckb?: string | number
}

/** A payment above the person's approval amount, asked about on the approvals page. */
export type Approval = {
  id: string
  /** waiting: not decided yet; approved: the next matching payment goes; used: it went; refused: by
   * the person; expired: not decided, or not used, in time. */
  status: 'waiting' | 'approved' | 'used' | 'refused' | 'expired'
  amount_ckb: string
  amount_shannons: string
  /** The host a seller's 402 came from. Approved, it lets one payment to that seller and payee go, up
   * to this amount: a seller makes a new invoice for each ask. Null for an invoice given as is,
   * which is matched by its payment hash. */
  seller: string | null
  payee: string | null
  payment_hash: string
  memo: string
  asked_at: number
  /** Until then it waits for the person, then (approved) for its payment. */
  expires_at: number
}

/** A payment the agent was asked for and did not make, and why: what a model tried, for the person. */
export type Refusal = { at: number; code: string; message: string; seller: string | null; memo: string }

export type TakeOut = {
  /** waiting: a payment is on its way, and the close starts once it ends, no new payment meanwhile;
   * closing: the channel is being closed together with the LSP; closed: its money is on chain at
   * the agent's address; returned: sent on to the person's address (`tx`); failed: see `error`. */
  status: 'waiting' | 'closing' | 'closed' | 'returned' | 'failed'
  /** The channel taken out: a take-out of an earlier channel says nothing of the one open now. */
  channel: string | null
  to: string | null
  tx: string | null
  /** Sent on after `tx`: what reached the agent's address later. */
  later?: string[]
  error: string | null
  at: number
}

export type AgentStatus = {
  /** A channel is open and can pay. */
  ready: boolean
  /** What the agent holds in its channel. */
  balance_ckb: string
  /** Paid, and on its way, through this agent since it began. */
  spent_ckb: string
  caps: { per_payment_ckb: string | null; total_ckb: string | null; left_ckb: string | null; day_ckb: string | null; day_left_ckb: string | null }
  /** Payments above this wait for the person's approval; null: none waits. */
  approve_above_ckb: string | null
  /** The sellers and payees it may pay; null: any. */
  allow: string[] | null
  /** The person stopped every payment (approvals page). */
  paused: boolean
  /** The stop in force, named anew at each: a go-again from the phone names the one it undoes. */
  paused_id: string | null
  waiting_approvals: number
  /** The LSP's opening fee, while it is not paid. */
  fee_due_ckb: string
  /** The person's address a take-out goes to, fixed at start; null: it stays at the agent's. */
  return_to: string | null
  take_out: TakeOut | null
}

type Saved = { payments: Payment[]; take_out: TakeOut | null; paused?: boolean; paused_id?: string }

export type AgentOptions = {
  session: PayerSession
  /** Where payments and their receipts are kept (JSON). Not the channel's own file. */
  file: string
  caps?: AgentCaps
  /** How long pay() waits for the payee's secret before answering "sending" (90 s unless told). */
  waitMs?: number
  /** Sends what came back on chain to the person's address once the channel is closed; resolves
   * with the transaction's hash. */
  sweep?: (to: string) => Promise<string>
  /** What the agent's own address holds on chain, in shannons: after a take-out, what came later
   * (the close seen late by the indexer the sweep reads) is sent on too. */
  balance?: () => Promise<bigint>
  /** How long after a sweep the agent's address is looked at again, three times (2 minutes unless told). */
  sweepAgainMs?: number
  /** The person's address the money goes back to (takeOut). Without it, it stays at the agent's. */
  returnTo?: string
  /** How long takeOut waits for the close before calling it failed (10 minutes unless told). */
  closeWaitMs?: number
  /** Sellers (the host a 402 comes from) and payees (node keys, 66 hex) it may pay; absent: any. */
  allow?: string[]
  /** Node keys that many sellers are paid at (its LSP's, for every seller the LSP hosts): refused in
   * `allow`, where one would let in any of them, an attacker's own hosted wallet included. */
  sharedPayees?: string[]
  /** A payment above this waits for the person's approval; absent: none waits. */
  approveAboveCkb?: string | number
  /** Where the person approves, said to whoever asked for the payment. */
  approvalsUrl?: string
  /** The person also approves on their phone (agent-phone.ts). Its link is not said: it is the
   * person's, from the agent's terminal, and the caller has no use for it. */
  phone?: boolean
  /** How long an approval waits for the person, and then for its payment (10 minutes unless told). */
  approvalMs?: number
  now?: () => number
  log?: (line: string) => void
}

const LIMITS = { memo: 200, invoice: 2000 }
const DAY_MS = 24 * 60 * 60 * 1000
// Kept in memory for the approvals page: the latest of each.
const KEPT = 50
// Less than this at the agent's address cannot be sent on in a cell of its own (61 CKB) with its fee.
const SWEEPABLE = 62n * 100_000_000n
const PAYEE = /^(0x)?(0[23][0-9a-f]{64})$/i
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class Agent {
  private o: AgentOptions
  private db: JsonFile<Saved>
  private perPayment: bigint | null
  private total: bigint | null
  private day: bigint | null
  private approveAbove: bigint | null
  private allowHosts: Set<string> | null = null
  private allowPayees: Set<string> | null = null
  private approvalList: Approval[] = []
  private refusalList: Refusal[] = []
  private closing: Promise<void> | null = null
  private carrying = false

  /** Starts the session and follows any payment still on its way from before. */
  static async open(o: AgentOptions): Promise<Agent> {
    const a = new Agent(o)
    await a.begin()
    return a
  }

  constructor(o: AgentOptions) {
    this.o = o
    this.db = new JsonFile<Saved>(o.file, () => ({ payments: [], take_out: null }))
    this.perPayment = o.caps?.per_payment_ckb == null ? null : shannonsOf(o.caps.per_payment_ckb)
    this.total = o.caps?.total_ckb == null ? null : shannonsOf(o.caps.total_ckb)
    this.day = o.caps?.day_ckb == null ? null : shannonsOf(o.caps.day_ckb)
    this.approveAbove = o.approveAboveCkb == null ? null : shannonsOf(o.approveAboveCkb)
    if (o.allow?.length) {
      this.allowHosts = new Set()
      this.allowPayees = new Set()
      const shared = new Set((o.sharedPayees ?? []).map((k) => k.toLowerCase().replace(/^0x/, '')))
      for (const entry of o.allow) {
        const key = entry.trim().match(PAYEE)
        if (key && shared.has(key[2]!.toLowerCase()))
          throw new MerchantError('invalid_request', `${entry.trim()} is the LSP's node key, which every seller it hosts is paid at: allow those sellers by their host names instead`, 400)
        if (key) this.allowPayees.add(key[2]!.toLowerCase())
        else this.allowHosts.add(entry.trim().toLowerCase())
      }
    }
  }

  private now() {
    return (this.o.now ?? Date.now)()
  }

  private async begin() {
    await this.o.session.start()
    for (const p of this.db.value.payments) {
      // Written here before it was handed to the session: one the session never wrote down was
      // never sent, the agent having stopped in between, so it ends failed rather than waiting for
      // good and holding a take-out back.
      if (p.status === 'sending' && !(await this.o.session.sentPayment(p.payment_hash))) await this.end(p, false, 'not sent: the agent stopped before handing it to the channel')
      else if (p.status === 'sending') void this.follow(p)
      else if (p.status === 'paid' && !p.preimage) void this.fill(p)
    }
    // A take-out waiting for a payment that has ended meanwhile, or one closed whose balance was not
    // sent on: carried on.
    const t = this.takingOut()
    if (t?.status === 'waiting' && !this.sending()) void this.closeNow(t).catch((e) => this.o.log?.(`take-out: ${message(e)}`))
    // One closing or closed when the agent stopped: nothing else would send it on, so it is
    // carried on here.
    else if (t?.status === 'closing' || t?.status === 'closed') this.carryOn(t)
  }

  /** Follows a take-out to its end (afterClose), once at a time. */
  private carryOn(t: TakeOut) {
    if (this.carrying) return
    this.carrying = true
    this.closing = this.afterClose(t).finally(() => (this.carrying = false))
  }

  private sending(): boolean {
    return this.db.value.payments.some((p) => p.status === 'sending')
  }

  /** Paid and on their way, since `since` (ms) or ever. */
  private spent(since = -Infinity): bigint {
    return this.db.value.payments.filter((p) => p.status !== 'failed' && p.created_at > since).reduce((n, p) => n + BigInt(p.amount_shannons), 0n)
  }

  status(): AgentStatus {
    const s = this.o.session.state
    const c = s.channel
    const fee = s.feeDue ?? 0n
    const spent = this.spent()
    const today = this.spent(this.now() - DAY_MS)
    const left = (cap: bigint | null, used: bigint) => (cap === null ? null : ckbOf(cap > used ? cap - used : 0n))
    return {
      ready: !!c?.ready && !c.closed && !s.closing,
      balance_ckb: ckbOf(c && !c.closed ? c.local : 0n),
      spent_ckb: ckbOf(spent),
      caps: {
        per_payment_ckb: this.perPayment === null ? null : ckbOf(this.perPayment),
        total_ckb: this.total === null ? null : ckbOf(this.total),
        left_ckb: left(this.total, spent),
        day_ckb: this.day === null ? null : ckbOf(this.day),
        day_left_ckb: left(this.day, today),
      },
      approve_above_ckb: this.approveAbove === null ? null : ckbOf(this.approveAbove),
      allow: this.allowHosts && this.allowPayees ? [...this.allowHosts, ...this.allowPayees] : null,
      paused: !!this.db.value.paused,
      paused_id: this.db.value.paused ? (this.db.value.paused_id ?? null) : null,
      waiting_approvals: this.approvals().filter((a) => a.status === 'waiting').length,
      fee_due_ckb: ckbOf(fee),
      return_to: this.o.returnTo ?? null,
      // The take-out of the channel open now: one of an earlier channel says nothing of this one, and
      // read as this one's it hid the take-out of a channel opened since (2026-11-01).
      take_out: (() => {
        const t = this.takingOut()
        return t && { ...t }
      })(),
    }
  }

  /** Newest first, with the ones out of time marked expired. */
  approvals(): Approval[] {
    this.expire()
    return this.approvalList.slice().reverse().map((a) => ({ ...a }))
  }

  /** Newest first. */
  refusals(): Refusal[] {
    return this.refusalList.slice().reverse().map((r) => ({ ...r }))
  }

  /** The person's answer to an approval still waiting (the approvals page, never the API). */
  decide(id: string, approve: boolean): Approval {
    this.expire()
    const a = this.approvalList.find((x) => x.id === id)
    if (!a || a.status !== 'waiting') throw new MerchantError('not_found', `no approval ${id} waiting`, 404)
    a.status = approve ? 'approved' : 'refused'
    a.expires_at = this.now() + this.approvalMs()
    this.o.log?.(`${approve ? 'approved' : 'refused'} by the person: ${a.amount_ckb} CKB${a.seller ? ` to ${a.seller}` : ''} (${a.id})`)
    return { ...a }
  }

  /** The person stops every payment, or lets the agent pay again (the approvals page, the phone).
   * Kept across a restart, so a stopped agent does not pay again by starting over. Each stop is named
   * anew (paused_id); a go-again from the phone says the stop it undoes (agent-phone.ts), so one held
   * back past a later stop undoes nothing. */
  async pause(paused: boolean): Promise<void> {
    this.db.value.paused = paused
    if (paused) this.db.value.paused_id = randomBytes(8).toString('hex')
    await this.db.save()
    this.o.log?.(paused ? 'payments stopped by the person' : 'payments allowed again by the person')
  }

  private approvalMs() {
    return this.o.approvalMs ?? 10 * 60_000
  }

  private expire() {
    const now = this.now()
    for (const a of this.approvalList) if ((a.status === 'waiting' || a.status === 'approved') && a.expires_at <= now) a.status = 'expired'
  }

  // The approval a payment is matched against: a seller's next invoice by seller, payee and amount,
  // an invoice given as is by its payment hash.
  // What the person saw on the card: an invoice given as is by its payment hash, its payee and at
  // most its amount, since anyone can make another invoice with the same hash (fnn new_invoice
  // takes one) for more, to another node; a seller's 402 by the
  // seller, its payee, what is bought (the request, as the card says it) and at most the amount.
  private matches(a: Approval, hash: string, seller: string | null, payee: string | null, amount: bigint, memo: string) {
    if (a.seller !== seller || a.payee !== payee || amount > BigInt(a.amount_shannons)) return false
    return seller !== null ? a.memo === memo : a.payment_hash === hash
  }

  // The take-out of the channel open now, if one was asked.
  private takingOut(): TakeOut | null {
    const t = this.db.value.take_out
    const id = this.o.session.state.channelId ?? null
    return t && (!id || !t.channel || t.channel === id) ? t : null
  }

  /** Newest first. */
  payments(o: { limit?: number } = {}): Payment[] {
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100)
    return this.db.value.payments.slice(-limit).reverse().map((p) => ({ ...p }))
  }

  get(paymentHash: string): Payment | null {
    const p = this.find(paymentHash)
    return p ? { ...p } : null
  }

  /** Pays an invoice that names its amount, within the caps and `max_ckb` (the caller's own limit
   * for this one). Resolves once the payee's secret is here (paid, with `preimage`), once it failed,
   * or after waitMs still sending (ask get() later). The same invoice again returns its payment.
   * `seller` is the host a 402 came from, set by the agent's own fetch, never by its caller. */
  pay(input: { invoice: string; max_ckb?: string | number; memo?: string; seller?: string }): Promise<Payment> {
    return this.start(input).then(
      (p) => (p.status === 'sending' ? this.settled(p) : { ...p }),
      (e) => {
        // A payment waiting for the person is not refused: their page lists it as waiting.
        if (e instanceof MerchantError && e.code !== 'needs_approval') {
          this.refusalList.push({ at: this.now(), code: e.code, message: e.message, seller: input?.seller ?? null, memo: input?.memo == null ? '' : String(input.memo).slice(0, LIMITS.memo) })
          if (this.refusalList.length > KEPT) this.refusalList.shift()
        }
        throw e
      },
    )
  }

  // The checks and the record. Nothing is awaited between the first check and the record, so two
  // payments at once cannot both pass a cap that only one of them fits in, nor both use one approval.
  private async start(input: { invoice: string; max_ckb?: string | number; memo?: string; seller?: string }): Promise<Payment> {
    const invoice = typeof input?.invoice === 'string' ? input.invoice.trim() : ''
    if (!invoice || invoice.length > LIMITS.invoice || !/^fib[a-z0-9]+$/i.test(invoice)) throw new MerchantError('invalid_invoice', 'invoice must be a Fiber invoice (fibt... on testnet)', 400)
    const memo = input.memo == null ? '' : String(input.memo).slice(0, LIMITS.memo)
    const max = input.max_ckb == null ? null : shannonsOf(input.max_ckb)
    const seller = typeof input.seller === 'string' && input.seller ? input.seller.toLowerCase() : null

    let read
    try {
      read = this.o.session.parseInvoice(invoice)
    } catch (e) {
      throw new MerchantError('invalid_invoice', `that invoice cannot be read: ${message(e)}`, 400)
    }
    const before = this.find(read.payment_hash)
    if (before) {
      if (before.status === 'failed') throw new MerchantError('payment_failed', 'paying that invoice failed before, and it cannot be tried again: ask the seller for a new one', 409)
      return before
    }
    if (this.db.value.paused) throw new MerchantError('paused', "the person stopped this agent's payments: nothing is paid until they let it pay again", 423)
    // A seller's request already paid for and on its way: another invoice for it would pay twice for
    // one thing.
    const on = seller ? this.db.value.payments.find((p) => p.status === 'sending' && p.memo === memo) : undefined
    if (on) throw new MerchantError('payment_pending', `a payment for this request (${on.payment_hash}) is still on its way: asking again now would pay twice; see it in the payments, and ask again once it has ended`, 409)
    if (read.expired) throw new MerchantError('expired', 'that invoice has expired', 410)
    if (!read.amount) throw new MerchantError('invalid_invoice', 'that invoice does not say how much: an agent pays only invoices that name their amount', 400)
    const amount = BigInt(read.amount)
    if (amount <= 0n) throw new MerchantError('invalid_invoice', 'that invoice asks for nothing', 400)
    if (max !== null && amount > max) throw new MerchantError('over_cap', `that invoice asks ${ckbOf(amount)} CKB, more than the ${ckbOf(max)} allowed for it`, 422)
    if (this.perPayment !== null && amount > this.perPayment) throw new MerchantError('over_cap', `that invoice asks ${ckbOf(amount)} CKB, more than the ${ckbOf(this.perPayment)} this agent may pay at once`, 422)
    const spent = this.spent()
    if (this.total !== null && spent + amount > this.total) throw new MerchantError('over_cap', `that invoice asks ${ckbOf(amount)} CKB, and this agent has ${ckbOf(this.total > spent ? this.total - spent : 0n)} left of its ${ckbOf(this.total)}`, 422)
    const today = this.spent(this.now() - DAY_MS)
    if (this.day !== null && today + amount > this.day) throw new MerchantError('over_cap', `that invoice asks ${ckbOf(amount)} CKB, and this agent has ${ckbOf(this.day > today ? this.day - today : 0n)} left of the ${ckbOf(this.day)} it may pay in any 24 hours`, 422)
    const payee = read.payee ? read.payee.toLowerCase().replace(/^0x/, '') : null
    if (this.allowHosts && this.allowPayees && !(seller && this.allowHosts.has(seller)) && !(payee && this.allowPayees.has(payee)))
      throw new MerchantError('not_allowed', `${seller ? `the seller ${seller}` : 'the payee of that invoice'} is not among those the person allows this agent to pay`, 403)
    const c = this.o.session.state.channel
    if (this.takingOut()) throw new MerchantError('not_ready', 'the person is taking its balance out: no payment now', 503)
    if (!c?.ready || c.closed || this.o.session.state.closing) throw new MerchantError('not_ready', 'the agent has no open channel to pay from', 503)
    if (amount > c.local) throw new MerchantError('too_large', `that invoice asks ${ckbOf(amount)} CKB, and the agent holds ${ckbOf(c.local)}`, 422)
    if (this.approveAbove !== null && amount > this.approveAbove) this.approved(read.payment_hash, seller, payee, amount, memo)

    const p: Payment = { payment_hash: read.payment_hash, invoice, amount_ckb: ckbOf(amount), amount_shannons: amount.toString(), memo, status: 'sending', preimage: null, error: null, created_at: this.now(), settled_at: null }
    this.db.value.payments.push(p)
    await this.db.save()
    try {
      await this.o.session.pay(invoice)
    } catch (e) {
      // An answer lost after the session recorded the payment (the LSP restarting, seen on testnet
      // 2026-10-31) says nothing of its end: it is followed like any other.
      if (await this.o.session.sentPayment(p.payment_hash).catch(() => undefined)) {
        this.o.log?.(`payment ${p.payment_hash.slice(0, 10)}: ${message(e)}; followed to its end`)
        void this.follow(p)
        return p
      }
      // Refused before anything left: by the signer, the LSP, or the route not there.
      await this.end(p, false, message(e))
      throw new MerchantError('payment_failed', message(e), 502)
    }
    this.o.log?.(`paying ${p.amount_ckb} CKB (${p.payment_hash.slice(0, 10)})${memo ? ` for ${memo}` : ''}`)
    void this.follow(p)
    return p
  }

  // A payment above the approval amount: the person's approval for it is used up, or it is asked for
  // (once while it waits) and the payment refused until they decide. A refusal stands for its time.
  private approved(hash: string, seller: string | null, payee: string | null, amount: bigint, memo: string) {
    this.expire()
    const now = this.now()
    const same = (status: Approval['status']) => this.approvalList.find((a) => a.status === status && this.matches(a, hash, seller, payee, amount, memo))
    const yes = same('approved')
    if (yes) {
      yes.status = 'used'
      return
    }
    const no = this.approvalList.find((a) => a.status === 'refused' && a.expires_at > now && this.matches(a, hash, seller, payee, amount, memo))
    if (no) throw new MerchantError('refused_by_person', `the person refused this payment (approval ${no.id}): do not ask for it again`, 403)
    let a = same('waiting')
    if (!a) {
      a = { id: randomBytes(6).toString('hex'), status: 'waiting', amount_ckb: ckbOf(amount), amount_shannons: amount.toString(), seller, payee, payment_hash: hash, memo, asked_at: now, expires_at: now + this.approvalMs() }
      // Room is made from what is over (used, expired), never from a refusal that stands or a payment
      // still waiting: fifty new asks would have pushed a refusal out.
      if (this.approvalList.length >= KEPT) {
        const over = this.approvalList.findIndex((x) => x.status === 'used' || x.status === 'expired' || (x.status === 'refused' && x.expires_at <= now))
        if (over < 0) throw new MerchantError('too_many_waiting', `${KEPT} payments wait for the person or were refused lately: nothing more is asked until they decide`, 429)
        this.approvalList.splice(over, 1)
      }
      this.approvalList.push(a)
      this.o.log?.(`waiting for the person's approval: ${a.amount_ckb} CKB${seller ? ` to ${seller}` : ''} (${a.id})${this.o.approvalsUrl ? ` at ${this.o.approvalsUrl}` : ''}`)
    }
    const where = `${this.o.approvalsUrl ? ` at ${this.o.approvalsUrl}` : " on the agent's approvals page"}${this.o.phone ? ', or with their wallet on their phone' : ''}`
    throw new MerchantError('needs_approval', `this payment of ${a.amount_ckb} CKB${seller ? ` to ${seller}` : ''} is above the ${ckbOf(this.approveAbove!)} CKB the person approves themselves: ask them to approve it${where} (approval ${a.id}, waiting ${Math.round(this.approvalMs() / 60_000)} minutes), then ask again`, 403)
  }

  // Waits up to waitMs for a payment's end, then answers as it stands.
  private async settled(p: Payment): Promise<Payment> {
    const wait = this.o.waitMs ?? 90_000
    for (const until = this.now() + wait; p.status === 'sending' && this.now() < until; ) await sleep(Math.min(200, wait))
    return { ...p }
  }

  // Its end, from the session: the payee's secret, or the payment failed.
  private async follow(p: Payment) {
    try {
      const paid = await this.o.session.whenSent(p.payment_hash)
      await this.end(p, paid, paid ? null : 'the payment did not go through', paid ? await this.receipt(p.payment_hash) : null)
    } catch (e) {
      this.o.log?.(`payment ${p.payment_hash.slice(0, 10)}: ${message(e)}`)
    }
  }

  // The session says a payment is paid as soon as the payee's secret reaches it, and writes the
  // secret down a moment later, once its round has read every payment (seen on testnet 2026-10-31:
  // read at once, the receipt was not there yet).
  private async receipt(paymentHash: string): Promise<string | null> {
    for (let i = 0; i < 100; i++) {
      const sent = await this.o.session.sentPayment(paymentHash)
      if (sent?.preimage) return sent.preimage
      await sleep(100)
    }
    return null
  }

  // A payment recorded paid without its receipt (before that wait existed): the receipt read again.
  private async fill(p: Payment) {
    const preimage = await this.receipt(p.payment_hash)
    if (!preimage) return
    p.preimage = preimage
    await this.db.save()
  }

  private async end(p: Payment, paid: boolean, error: string | null, preimage: string | null = null) {
    if (p.status !== 'sending') return
    p.status = paid ? 'paid' : 'failed'
    p.preimage = preimage
    p.error = error
    p.settled_at = this.now()
    await this.db.save()
    this.o.log?.(paid ? `paid ${p.amount_ckb} CKB (${p.payment_hash.slice(0, 10)})` : `payment ${p.payment_hash.slice(0, 10)} failed: ${error}`)
    const t = this.takingOut()
    if (t?.status === 'waiting' && !this.sending()) void this.closeNow(t).catch((e) => this.o.log?.(`take-out: ${message(e)}`))
  }

  /** Takes the balance out: the channel closed together with the LSP, then what came back on chain
   * sent on to the person's address (returnTo) when there is one. Resolves once the close is asked;
   * status().take_out follows it. Refused while a payment is on its way. */
  async takeOut(): Promise<TakeOut> {
    const known = this.takingOut()
    const c = this.o.session.state.channel
    // Returned, and something reached the agent's address since: sent on as well.
    if (known?.status === 'returned' && !(c?.ready && !c.closed) && (await this.leftover())) {
      this.closing = this.sendLater(known)
      return { ...known }
    }
    if (known && (known.status === 'closing' || known.status === 'closed')) {
      this.carryOn(known)
      return { ...known }
    }
    if (known && known.status !== 'failed') return { ...known }
    // Closed already, by a take-out whose sweep failed or by the LSP (an idle channel, after 14 days
    // on LSP2): what came back to the agent's address is sent on, not left there with "nothing to
    // take out".
    if (c?.closed) {
      const t: TakeOut = known ?? { status: 'closed', channel: this.o.session.state.channelId ?? null, to: this.o.returnTo ?? null, tx: null, error: null, at: this.now() }
      this.db.value.take_out = t
      await this.db.save()
      this.carryOn(t)
      return { ...t, status: 'closed', error: null }
    }
    if (!c?.ready) throw new MerchantError('not_ready', 'the agent has no open channel to take out', 503)
    const t: TakeOut = { status: 'closing', channel: this.o.session.state.channelId ?? null, to: this.o.returnTo ?? null, tx: null, error: null, at: this.now() }
    // A payment on its way (a seller can hold one for days): the take-out waits for it, starting no
    // other, and closes once it ends, instead of answering busy and leaving the person to try again.
    if (this.sending()) {
      t.status = 'waiting'
      this.db.value.take_out = t
      await this.db.save()
      this.o.log?.('taking the balance out once the payment on its way has ended; no new payment meanwhile')
      return { ...t }
    }
    this.db.value.take_out = t
    await this.db.save()
    await this.closeNow(t)
    return { ...t }
  }

  /** Closes the channel for a take-out, then sends its balance on (afterClose). */
  private async closeNow(t: TakeOut) {
    const c = this.o.session.state.channel
    t.status = 'closing'
    await this.db.save()
    try {
      if (!c?.closed) await this.o.session.close()
    } catch (e) {
      t.status = 'failed'
      t.error = message(e)
      await this.db.save()
      throw new MerchantError('busy', `the channel could not be closed now: ${t.error}`, 409)
    }
    this.o.log?.('taking the balance out: closing the channel with the LSP')
    this.carryOn(t)
  }

  /** Resolves once a take-out under way has ended (for tests and the CLI). */
  async takenOut(): Promise<TakeOut | null> {
    await this.closing
    return this.db.value.take_out && { ...this.db.value.take_out }
  }

  private async afterClose(t: TakeOut) {
    t.error = null
    // To the address the person set now: one kept from an earlier start may be an old one.
    t.to = this.o.returnTo ?? null
    const wait = this.o.closeWaitMs ?? 600_000
    for (const until = this.now() + wait; !this.o.session.state.channel?.closed && this.now() < until; ) await sleep(Math.min(2_000, wait))
    if (!this.o.session.state.channel?.closed) {
      t.status = 'failed'
      t.error = 'the channel did not close in time: take out again'
      await this.db.save()
      return
    }
    t.status = 'closed'
    await this.db.save()
    if (!t.to || !this.o.sweep) return
    try {
      t.tx = await this.o.sweep(t.to)
      t.status = 'returned'
      this.o.log?.(`balance returned to ${t.to} (${t.tx})`)
    } catch (e) {
      t.status = 'failed'
      t.error = `closed, but not yet sent on to ${t.to}: ${message(e)}`
    }
    await this.db.save()
    // The sweep takes what the indexer shows then; the close it waited for may show a little later:
    // looked at again three times, and what came is sent on.
    if (t.status !== 'returned' || !this.o.balance) return
    const every = this.o.sweepAgainMs ?? 120_000
    for (let i = 0; i < 3; i++) {
      await sleep(every)
      if (await this.leftover()) await this.sendLater(t)
    }
  }

  /** True when the agent's own address holds enough to send on in a cell of its own. */
  private async leftover(): Promise<boolean> {
    if (!this.o.balance || !this.o.sweep) return false
    try {
      return (await this.o.balance()) >= SWEEPABLE
    } catch {
      return false
    }
  }

  /** Sends on to the person's address what reached the agent's address after a take-out. */
  private async sendLater(t: TakeOut) {
    t.to = this.o.returnTo ?? null
    if (!t.to || !this.o.sweep) return
    try {
      const tx = await this.o.sweep(t.to)
      t.later = [...(t.later ?? []), tx]
      this.o.log?.(`what came after the take-out sent on to ${t.to} (${tx})`)
    } catch (e) {
      this.o.log?.(`what came after the take-out was not sent on yet: ${message(e)}`)
    }
    await this.db.save()
  }

  private find(paymentHash: string): Payment | undefined {
    const k = String(paymentHash ?? '').toLowerCase()
    return this.db.value.payments.find((p) => p.payment_hash.toLowerCase() === k)
  }
}
