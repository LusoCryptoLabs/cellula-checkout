// A shop's side of Fiber payments, in the shape shops know from Stripe: an invoice for an order, a
// promise that settles when the money is in the shop's channel, events, and a signed webhook to
// the shop's server. Underneath, a FiberSession runs on the server (nodeHost): the shop's channel
// stays open and its signer stays here, so a payment is the shop's the moment the signer releases
// the invoice's secret. Nothing here takes the payer's word: paid means released by this signer.

import { randomBytes } from 'node:crypto'
import { ckbOf, shannonsOf } from './amount.ts'
import { MerchantError } from './errors.ts'
import type { RailRent, RoomRail } from './room.ts'
import { JsonFile } from './store.ts'
import { Webhooks, type Pending, type WebhookTarget } from './webhook.ts'

/** What a merchant needs of a Fiber session; FiberSession on a server does all of it. */
export interface PaySession {
  start(): Promise<void>
  invoice(amount: bigint, opts?: { description?: string; validMs?: number }): Promise<{ paymentHash: string; invoice: string; expiresAt: number }>
  onPaid(fn: (paymentHash: string, amount: bigint) => void): () => void
  invoiceState(paymentHash: string): { status: string; released: boolean } | undefined
  /** Invoices made before this process started, for a session that does not keep them itself (a
   * shop's own node, node-session.ts): what is known of each, before they are looked at. */
  resume?(paymentHashes: string[]): Promise<void>
  /** The LSP's opening fee, paid from the channel (FiberSession.payOpeningFee); null when nothing
   * was due. A shop's own node pays none and leaves it out. */
  payOpeningFee?(): Promise<string | null>
  /** Called on each change of `state`. */
  subscribe?(fn: () => void): () => void
  /** `feeDue`: the LSP's opening fee, in shannons, while it is not paid (0 or absent when none). */
  readonly state: { channel: { ready: boolean; closed: boolean; local: bigint; remote: bigint } | null; feeDue?: bigint }
}

export type InvoiceStatus = 'open' | 'paid' | 'expired'

export type Invoice = {
  id: string
  payment_hash: string
  /** The Fiber invoice to hand to whoever pays: fibt then the amount on testnet, fibb on mainnet. */
  invoice: string
  amount_ckb: string
  amount_shannons: string
  memo: string
  order_id: string | null
  metadata: Record<string, string>
  status: InvoiceStatus
  /** Milliseconds since 1970, as Date.now(). */
  created_at: number
  expires_at: number
  paid_at: number | null
}

export type NewInvoice = {
  amount_ckb: string | number
  memo?: string
  /** The shop's own id for what is being paid. Asking again for an order with an open invoice of
   * the same amount returns that invoice, so a retried request never makes two. */
  order_id?: string
  metadata?: Record<string, string>
  /** How long it can be paid: 1 minute to 24 hours, an hour unless told. */
  valid_minutes?: number
}

export type MerchantStatus = {
  /** A channel is open and ready to be paid into. */
  ready: boolean
  /** The most one payment can bring now: the channel's room to receive. */
  can_receive_ckb: string
  /** What the shop holds in its channel. */
  balance_ckb: string
}

/** Room to receive rented from the LSP (room.ts). Times in ms. */
export type Rent = {
  payment_hash: string
  room_ckb: string
  months: number
  price_ckb: string
  /** unpaid: asked, not seen paid yet; waiting: paid, its room not in a channel yet; moving: the
   * channel taken out, the rent goes to the next one at the next start; running; ended. */
  status: 'unpaid' | 'waiting' | 'moving' | 'running' | 'ended'
  start: number | null
  until: number | null
  asked_at: number
  /** room.ending was said. */
  warned: boolean
}

export type RoomTerms = { per_month: number; least_ckb: string; most_ckb: string; month_days: number }

export type NewRent = { room_ckb: string | number; months?: number }

type SavedRent = Rent & { claim?: string }

type Saved = { invoices: Invoice[]; webhooks: Pending[]; rents?: SavedRent[] }

export type MerchantOptions = {
  session: PaySession
  /** Where invoices and undelivered webhooks are kept (JSON). Not the channel's own file. */
  file: string
  webhook?: WebhookTarget
  /** How often open invoices are looked at for expiry (ms). */
  sweepMs?: number
  now?: () => number
  fetch?: typeof fetch
  log?: (line: string) => void
  /** The waits between webhook attempts (RETRY_MS unless told). */
  retryMs?: number[]
  /** Renting room to receive from the LSP (room.ts); without it, rentRoom is refused. */
  room?: RoomRail
  /** How long before a rent ends room.ending is said (a week unless told). */
  roomWarnMs?: number
  /** When paid room is brought into a channel: once no invoice is open (idle), or only when told
   * (manual, placeRoom). Hosted, bringing it in takes the channel out for a minute or two. */
  roomPlace?: 'idle' | 'manual'
}

type Event = 'paid' | 'expired'
export type RoomEvent = 'room.placed' | 'room.ending' | 'room.ended'

const WEEK_MS = 7 * 86_400_000
// An unpaid rent's invoice is valid an hour: after two, it is dropped.
const RENT_UNPAID_MS = 2 * 3_600_000

// A payment in flight when its invoice runs out still lands: a minute's grace before calling it
// expired.
const GRACE_MS = 60_000
// An opening fee that could not be paid is tried again this long after (the LSP not answering, a
// route not there yet): not at every change of the session, several a second.
const FEE_AGAIN_MS = 60_000
const LIMITS = { memo: 200, order: 100, keys: 20, key: 40, value: 500 }

export class Merchant {
  private o: MerchantOptions
  private db: JsonFile<Saved>
  private hooks: Webhooks | null
  private waiters = new Map<string, { done: (i: Invoice) => void; fail: (e: Error) => void }[]>()
  private listeners: Record<Event, Set<(i: Invoice) => void>> = { paid: new Set(), expired: new Set() }
  private roomListeners: Record<RoomEvent, Set<(r: Rent) => void>> = { 'room.placed': new Set(), 'room.ending': new Set(), 'room.ended': new Set() }
  private placing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private fee: Promise<void> | null = null
  private feeAgainAt = 0
  private unsubscribe: (() => void) | null = null

  /** Starts the session, records what was paid while this process was down, and keeps going. */
  static async open(o: MerchantOptions): Promise<Merchant> {
    const m = new Merchant(o)
    await m.begin()
    return m
  }

  constructor(o: MerchantOptions) {
    this.o = o
    this.db = new JsonFile<Saved>(o.file, () => ({ invoices: [], webhooks: [] }))
    this.hooks = o.webhook
      ? new Webhooks({
          target: o.webhook,
          load: () => this.db.value.webhooks,
          save: async (pending) => {
            this.db.value.webhooks = pending
            await this.db.save()
          },
          fetch: o.fetch,
          now: o.now,
          log: o.log,
          retryMs: o.retryMs,
        })
      : null
  }

  private now() {
    return (this.o.now ?? Date.now)()
  }

  private async begin() {
    this.o.session.onPaid((hash) => void this.paid(hash))
    this.unsubscribe = this.o.session.subscribe?.(() => void this.payOpeningFee()) ?? null
    await this.o.session.start()
    void this.payOpeningFee()
    await this.roomArrived()
    // The signer releases on start what arrived while this process was away; its listeners may
    // have run before ours was there, so look at every open invoice once.
    await this.o.session.resume?.(this.db.value.invoices.filter((i) => i.status !== 'paid').map((i) => i.payment_hash))
    for (const inv of this.db.value.invoices) if (inv.status !== 'paid' && this.o.session.invoiceState(inv.payment_hash)?.released) await this.paid(inv.payment_hash)
    this.timer = setInterval(() => void this.sweep(), this.o.sweepMs ?? 15_000)
    this.timer.unref?.()
    this.hooks?.resume()
  }

  /** Stops the expiry sweep and the webhook retries (the session goes on by itself). */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
    this.hooks?.stop()
  }

  private feeDue(): boolean {
    return (this.o.session.state.feeDue ?? 0n) > 0n
  }

  /** The channel is open and waits for the LSP's opening fee: this merchant is paying it, or pays it
   * again within a minute (payOpeningFee). Not ready meanwhile, though not closed either. */
  waitsForFee(): boolean {
    const c = this.o.session.state.channel
    return !!c?.ready && !c.closed && this.feeDue()
  }

  /** The LSP's opening fee (500 CKB on testnet, once per wallet), paid from the channel as soon as it is
   * ready, as the wallet's session pays it: until it is paid the LSP takes no payment into the
   * channel. Paid once at a time; one that failed is tried again a minute later. Resolves when the
   * try under way, if any, has ended; never rejects. */
  payOpeningFee(): Promise<void> {
    if (this.fee) return this.fee
    const s = this.o.session
    const c = s.state.channel
    if (!s.payOpeningFee || !c?.ready || c.closed || !this.feeDue() || this.now() < this.feeAgainAt) return Promise.resolve()
    this.o.log?.(`paying the LSP's opening fee, ${ckbOf(s.state.feeDue!)} CKB once`)
    // Kept before it is asked: the session's own changes while it pays call this again.
    let ended!: () => void
    this.fee = new Promise<void>((r) => (ended = r))
    void Promise.resolve()
      .then(() => s.payOpeningFee!())
      .then(
        (hash) => this.o.log?.(hash ? `opening fee paid (${hash.slice(0, 10)})` : 'no opening fee due after all'),
        (e) => {
          this.feeAgainAt = this.now() + FEE_AGAIN_MS
          this.o.log?.(`opening fee not paid, tried again in a minute: ${e instanceof Error ? e.message : String(e)}`)
        },
      )
      .finally(() => {
        this.fee = null
        ended()
      })
    return this.fee
  }

  status(): MerchantStatus {
    const c = this.o.session.state.channel
    // While the opening fee is due the LSP takes no payment into it.
    const ready = !!c?.ready && !c.closed && !this.feeDue()
    return { ready, can_receive_ckb: ckbOf(ready ? c!.remote : 0n), balance_ckb: ckbOf(c?.local ?? 0n) }
  }

  async createInvoice(input: NewInvoice): Promise<Invoice> {
    const amount = shannonsOf(input?.amount_ckb as string | number)
    if (amount <= 0n) throw new MerchantError('invalid_amount', 'amount_ckb must be more than 0', 400)
    const memo = text(input.memo, 'memo', LIMITS.memo)
    const order = input.order_id == null || input.order_id === '' ? null : text(input.order_id, 'order_id', LIMITS.order)
    const metadata = meta(input.metadata)
    const minutes = input.valid_minutes ?? 60
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new MerchantError('invalid_request', 'valid_minutes must be a whole number from 1 to 1440', 400)

    if (order) {
      const same = this.db.value.invoices.filter((i) => i.order_id === order)
      if (same.some((i) => i.status === 'paid')) throw new MerchantError('order_paid', `order ${order} is paid already`, 409)
      const open = same.find((i) => i.status === 'open' && i.amount_shannons === amount.toString() && i.expires_at > this.now())
      if (open) return { ...open }
    }

    const c = this.o.session.state.channel
    if (!c?.ready || c.closed) throw new MerchantError('not_ready', 'the shop has no open channel to be paid into yet', 503)
    if (this.feeDue()) {
      void this.payOpeningFee()
      throw new MerchantError('not_ready', "the shop's channel pays the LSP's opening fee first: ask again in a minute", 503)
    }
    if (amount > c.remote) throw new MerchantError('too_large', `one payment can bring ${ckbOf(c.remote)} CKB now, not ${ckbOf(amount)}`, 422)

    let sale
    try {
      sale = await this.o.session.invoice(amount, { description: memo || (order ? `Order ${order}` : 'Payment'), validMs: minutes * 60_000 })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      if (/no ready channel/.test(why)) throw new MerchantError('not_ready', 'the shop has no open channel to be paid into yet', 503)
      if (/channel can take/.test(why)) throw new MerchantError('too_large', why, 422)
      throw e
    }
    const inv: Invoice = {
      id: `inv_${randomBytes(12).toString('hex')}`,
      payment_hash: sale.paymentHash,
      invoice: sale.invoice,
      amount_ckb: ckbOf(amount),
      amount_shannons: amount.toString(),
      memo,
      order_id: order,
      metadata,
      status: 'open',
      created_at: this.now(),
      expires_at: sale.expiresAt,
      paid_at: null,
    }
    this.db.value.invoices.push(inv)
    await this.db.save()
    return { ...inv }
  }

  /** By its id (inv_...) or its payment hash. */
  get(idOrHash: string): Invoice | null {
    const inv = this.find(idOrHash)
    return inv ? { ...inv } : null
  }

  /** Newest first. */
  list(o: { status?: InvoiceStatus; order_id?: string; limit?: number } = {}): Invoice[] {
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100)
    return this.db.value.invoices
      .filter((i) => (!o.status || i.status === o.status) && (!o.order_id || i.order_id === o.order_id))
      .slice(-limit)
      .reverse()
      .map((i) => ({ ...i }))
  }

  /** Resolves with the invoice once paid; fails when it expires, or after `timeoutMs`. */
  waitPaid(idOrHash: string, o: { timeoutMs?: number } = {}): Promise<Invoice> {
    const inv = this.find(idOrHash)
    if (!inv) return Promise.reject(new MerchantError('not_found', `no invoice ${idOrHash}`, 404))
    if (inv.status === 'paid') return Promise.resolve({ ...inv })
    if (inv.status === 'expired') return Promise.reject(new MerchantError('expired', `invoice ${inv.id} expired unpaid`, 410))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const list = this.waiters.get(inv.payment_hash) ?? []
      const w = {
        done: (i: Invoice) => {
          if (timer) clearTimeout(timer)
          resolve(i)
        },
        fail: (e: Error) => {
          if (timer) clearTimeout(timer)
          reject(e)
        },
      }
      list.push(w)
      this.waiters.set(inv.payment_hash, list)
      if (o.timeoutMs) {
        timer = setTimeout(() => {
          this.waiters.set(inv.payment_hash, (this.waiters.get(inv.payment_hash) ?? []).filter((x) => x !== w))
          reject(new MerchantError('timeout', `invoice ${inv.id} not paid in ${o.timeoutMs} ms`, 408))
        }, o.timeoutMs)
      }
    })
  }

  /** Each paid (or expired) invoice, once. Returns a function that stops listening. */
  on(event: Event, fn: (i: Invoice) => void): () => void {
    this.listeners[event].add(fn)
    return () => this.listeners[event].delete(fn)
  }

  /** Webhook deliveries still waiting for a 2xx from the shop. */
  webhooksWaiting(): Pending[] {
    return this.hooks?.waiting() ?? []
  }

  /** What more room to receive costs from the LSP; null where it rents none. */
  async roomTerms(): Promise<RoomTerms | null> {
    const t = await this.rail().terms()
    return t && { per_month: t.perMonth, least_ckb: ckbOf(t.least), most_ckb: ckbOf(t.most), month_days: Math.round(t.monthMs / 86_400_000) }
  }

  /** Rent `room_ckb` of room for `months` of 30 days: the LSP's invoice is paid from the shop's
   * channel, and the room comes with the next channel (roomPlace). A rent paid while one of as much
   * room runs starts at its end and needs no new channel. */
  async rentRoom(input: NewRent): Promise<Rent> {
    const rail = this.rail()
    const room = shannonsOf(input?.room_ckb as string | number)
    const months = input?.months ?? 1
    if (room <= 0n) throw new MerchantError('invalid_amount', 'room_ckb must be more than 0', 400)
    if (!Number.isInteger(months) || months < 1 || months > 12) throw new MerchantError('invalid_request', 'months must be a whole number from 1 to 12', 400)
    if (this.rentsWith('moving').length) throw new MerchantError('busy', 'room is moving to the next channel: ask again once the shop has started again', 409)
    let r: RailRent
    try {
      r = await rail.rent(room, months)
    } catch (e) {
      throw new MerchantError('rent_failed', e instanceof Error ? e.message : String(e), 502)
    }
    const rent: SavedRent = { payment_hash: r.paymentHash, room_ckb: ckbOf(r.room), months: r.months, price_ckb: ckbOf(r.price), status: 'unpaid', start: r.start, until: r.until, asked_at: this.now(), warned: false, claim: r.claim }
    if (r.paid) this.paidRent(rent)
    this.saved().push(rent)
    await this.db.save()
    this.o.log?.(`rent ${rent.payment_hash.slice(0, 10)}: ${rent.room_ckb} CKB of room for ${months} x 30 days, ${rent.price_ckb} CKB, ${rent.status}`)
    return pub(rent)
  }

  /** The shop's rents, newest first. */
  rents(): Rent[] {
    return this.saved().slice().reverse().map(pub)
  }

  /** Bring paid room into a channel now, whatever is under way. */
  async placeRoom(): Promise<void> {
    await this.place(true)
  }

  /** Each room.placed, room.ending and room.ended. Returns a function that stops listening. */
  onRoom(event: RoomEvent, fn: (r: Rent) => void): () => void {
    this.roomListeners[event].add(fn)
    return () => this.roomListeners[event].delete(fn)
  }

  private rail(): RoomRail {
    if (!this.o.room) throw new MerchantError('no_room', 'renting room is not set up for this shop', 501)
    return this.o.room
  }

  private saved(): SavedRent[] {
    return (this.db.value.rents ??= [])
  }

  private rentsWith(...status: Rent['status'][]): SavedRent[] {
    return this.saved().filter((r) => status.includes(r.status))
  }

  // Paid: its room waits for a channel, unless a rent of as much room running now already put it
  // in one and this one only follows it.
  private paidRent(r: SavedRent) {
    const now = this.now()
    const follows = (r.start ?? 0) > now && this.rentsWith('running').some((x) => (x.until ?? 0) > now && shannonsOf(x.room_ckb) >= shannonsOf(r.room_ckb))
    r.status = follows ? 'running' : 'waiting'
  }

  // After a start: rents that moved with a hosted channel taken out go to this new tenant before
  // its channel opens, so the LSP funds it the room.
  private async roomArrived() {
    const moving = this.rentsWith('moving')
    if (!moving.length || !this.o.room?.move) return
    for (const r of moving) {
      await this.o.room.move(r.payment_hash, r.claim ?? '')
      r.status = 'running'
      await this.db.save()
      this.o.log?.(`rent ${r.payment_hash.slice(0, 10)} moved to this channel: its room comes with the opening`)
      this.roomEvent('room.placed', r)
    }
  }

  // Paid room into a channel: once nothing is open to be paid (or when told). Hosted, the process
  // starts again on the way (the service brings it back) and roomArrived finishes it.
  private async place(force: boolean) {
    const waiting = this.rentsWith('waiting')
    if (!waiting.length || this.placing || !this.o.room) return
    if (!force && this.o.roomPlace === 'manual') return
    if (!force && this.db.value.invoices.some((i) => i.status === 'open' && i.expires_at + GRACE_MS > this.now())) return
    const hosted = !!this.o.room.move
    this.placing = true
    try {
      if (hosted) {
        for (const r of waiting) r.status = 'moving'
        await this.db.save()
        this.o.log?.('taking the channel out to open it again with the rented room')
      }
      await this.o.room.place()
      if (!hosted) {
        for (const r of waiting) {
          r.status = 'running'
          this.roomEvent('room.placed', r)
        }
        await this.db.save()
      }
    } catch (e) {
      // Nothing was closed (or the close did not go through): wait and try again.
      for (const r of waiting) if (r.status === 'moving') r.status = 'waiting'
      await this.db.save()
      this.o.log?.(`rented room not brought in yet: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.placing = false
    }
  }

  private async roomSweep() {
    if (!this.o.room) return
    const now = this.now()
    let changed = false
    for (const r of this.rentsWith('unpaid')) {
      if (now - r.asked_at > RENT_UNPAID_MS) {
        this.db.value.rents = this.saved().filter((x) => x !== r)
        changed = true
        continue
      }
      const s = await this.o.room.status(r.payment_hash).catch(() => null)
      if (!s?.paid) continue
      r.start = s.start
      r.until = s.until
      this.paidRent(r)
      changed = true
    }
    // Told once a week before the end, and at the end, unless a rent paid since follows it.
    const warn = this.o.roomWarnMs ?? WEEK_MS
    for (const r of this.rentsWith('waiting', 'running')) {
      if (r.until == null) continue
      const followed = this.saved().some((x) => x !== r && x.status !== 'unpaid' && x.start != null && x.until != null && x.start <= r.until! && x.until > r.until!)
      if (now >= r.until) {
        r.status = 'ended'
        changed = true
        if (!followed) this.roomEvent('room.ended', r)
      } else if (!r.warned && !followed && r.until - now <= warn) {
        r.warned = true
        changed = true
        this.roomEvent('room.ending', r)
      }
    }
    if (changed) await this.db.save()
    await this.place(false)
  }

  private roomEvent(event: RoomEvent, r: SavedRent) {
    const copy = pub(r)
    for (const fn of this.roomListeners[event]) {
      try {
        fn({ ...copy })
      } catch (e) {
        this.o.log?.(`a ${event} listener failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    void this.hooks?.send(event, { rent: copy })
  }

  private find(idOrHash: string): Invoice | undefined {
    const k = String(idOrHash ?? '').toLowerCase()
    return this.db.value.invoices.find((i) => i.id === k || i.payment_hash.toLowerCase() === k)
  }

  // The session's word that the signer released this invoice's secret: the payment is in the
  // shop's channel. Called again after a restart for the same hash; recorded once.
  private async paid(hash: string) {
    const inv = this.find(hash)
    if (!inv || inv.status === 'paid') return
    inv.status = 'paid'
    inv.paid_at = this.now()
    await this.db.save()
    this.o.log?.(`invoice ${inv.id} paid: ${inv.amount_ckb} CKB${inv.order_id ? ` for order ${inv.order_id}` : ''}`)
    this.settle(inv, 'paid')
  }

  private async sweep() {
    const now = this.now()
    let changed = false
    for (const inv of this.db.value.invoices) {
      if (inv.status !== 'open') continue
      if (this.o.session.invoiceState(inv.payment_hash)?.released) {
        await this.paid(inv.payment_hash)
        continue
      }
      if (inv.expires_at + GRACE_MS > now) continue
      inv.status = 'expired'
      changed = true
      this.settle(inv, 'expired')
    }
    if (changed) await this.db.save()
    await this.roomSweep().catch((e) => this.o.log?.(`room: ${e instanceof Error ? e.message : String(e)}`))
  }

  private settle(inv: Invoice, event: Event) {
    const copy = { ...inv }
    for (const w of this.waiters.get(inv.payment_hash) ?? []) {
      if (event === 'paid') w.done({ ...copy })
      else w.fail(new MerchantError('expired', `invoice ${inv.id} expired unpaid`, 410))
    }
    this.waiters.delete(inv.payment_hash)
    for (const fn of this.listeners[event]) {
      try {
        fn({ ...copy })
      } catch (e) {
        this.o.log?.(`a ${event} listener failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    void this.hooks?.send(`invoice.${event}`, { invoice: copy })
  }
}

/** A rent as the shop sees it: its claim stays here. */
function pub(r: SavedRent): Rent {
  const { claim: _claim, ...rest } = r
  return { ...rest }
}

function text(v: unknown, name: string, max: number): string {
  if (v == null) return ''
  if (typeof v !== 'string') throw new MerchantError('invalid_request', `${name} must be text`, 400)
  if (v.length > max) throw new MerchantError('invalid_request', `${name} is longer than ${max} characters`, 400)
  return v
}

function meta(v: unknown): Record<string, string> {
  if (v == null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new MerchantError('invalid_request', 'metadata must be an object of text values', 400)
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length > LIMITS.keys) throw new MerchantError('invalid_request', `metadata holds at most ${LIMITS.keys} keys`, 400)
  const out: Record<string, string> = {}
  for (const [k, val] of entries) {
    if (k.length > LIMITS.key || typeof val !== 'string' || val.length > LIMITS.value) throw new MerchantError('invalid_request', `metadata keys are up to ${LIMITS.key} characters and values text up to ${LIMITS.value}`, 400)
    out[k] = val
  }
  return out
}
