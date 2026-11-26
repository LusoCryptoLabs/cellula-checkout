// A Fiber network in a test: a shop's session whose invoices carry a real preimage (its hash is CKB's
// blake2b of it, as Fiber's), and an agent's session that pays them. What the agent needs of
// FiberSession, without a chain.

import { randomBytes } from 'node:crypto'
import { ccc } from '@ckb-ccc/core'
import type { PayerSession } from '../src/agent.ts'
import { SHANNONS } from '../src/amount.ts'
import { FakeSession } from './fake.ts'

type Bill = { hash: string; preimage: string; amount: bigint | null; expired: boolean; currency: string; payee: string; shop?: FakeShop }

/** Invoices by their text, shared by the shops and the payers of one test. */
export class FakeNet {
  bills = new Map<string, Bill>()
  private n = 0

  /** An invoice made outside any shop: `amount` null for one that names none. */
  bill(amount: bigint | null, o: { expired?: boolean; currency?: string; payee?: string; shop?: FakeShop } = {}): { invoice: string; hash: string; preimage: string } {
    const preimage = `0x${randomBytes(32).toString('hex')}`
    const hash = ccc.hashCkb(preimage)
    const invoice = `fibt${amount ?? 0n}x${++this.n}`
    this.bills.set(invoice, { hash, preimage, amount, expired: !!o.expired, currency: o.currency ?? 'Fibt', payee: o.payee ?? '02lsp', shop: o.shop })
    return { invoice, hash, preimage }
  }
}

/** A shop whose invoices are bills on the net; paying one releases it in the shop. */
export class FakeShop extends FakeSession {
  net: FakeNet
  constructor(net: FakeNet) {
    super()
    this.net = net
  }

  override async invoice(amount: bigint, o: { description?: string; validMs?: number } = {}) {
    const c = this.state.channel
    if (!c?.ready) throw new Error('no ready channel to be paid into')
    const b = this.net.bill(amount, { shop: this })
    this.invoices.set(b.hash, { amount, released: false })
    return { paymentHash: b.hash, invoice: b.invoice, expiresAt: this.now() + (o.validMs ?? 3_600_000) }
  }
}

export type Outcome = 'paid' | 'failed' | 'hang'

export class FakePayer implements PayerSession {
  net: FakeNet
  state = { channelId: '0xc1' as string | null, channel: { ready: true, closed: false, local: 100n * SHANNONS, remote: 100n * SHANNONS } as { ready: boolean; closed: boolean; local: bigint; remote: bigint } | null, feeDue: 0n, closing: false }
  /** What the next payments end as, in order; 'paid' once the list is empty. */
  outcomes: Outcome[] = []
  /** Refuse the next pay() before anything leaves, with this message. */
  refuse: string | null = null
  /** Lose the next pay()'s answer after the payment was recorded and sent, with this message. */
  lose: string | null = null
  /** Whether close() closes the channel by itself after a turn. */
  closes = true
  pays: string[] = []
  starts = 0
  private sent = new Map<string, { status: string; preimage?: string }>()
  private waiters = new Map<string, ((paid: boolean) => void)[]>()
  private hung = new Map<string, Bill>()
  private ended = new Map<string, boolean>()

  constructor(net: FakeNet) {
    this.net = net
  }

  async start() {
    this.starts++
  }

  parseInvoice(invoice: string) {
    const b = this.net.bills.get(invoice)
    if (!b) throw new Error('invalid invoice: bad checksum')
    return { payment_hash: b.hash, amount: b.amount === null ? null : b.amount.toString(), currency: b.currency, expired: b.expired, payee: b.payee }
  }

  async pay(invoice: string) {
    if (this.refuse) {
      const why = this.refuse
      this.refuse = null
      throw new Error(why)
    }
    const b = this.net.bills.get(invoice)
    if (!b) throw new Error('invalid invoice')
    this.pays.push(b.hash)
    this.sent.set(b.hash, { status: 'Created' })
    this.state.channel!.local -= b.amount ?? 0n
    const outcome = this.outcomes.shift() ?? 'paid'
    if (outcome === 'hang') this.hung.set(b.hash, b)
    else setImmediate(() => this.settle(b, outcome === 'paid'))
    if (this.lose) {
      const why = this.lose
      this.lose = null
      throw new Error(why)
    }
    return b.hash
  }

  /** A payment left hanging ends now. */
  finish(hash: string, paid = true) {
    const b = this.hung.get(hash)
    if (!b) throw new Error(`no hanging payment ${hash}`)
    this.hung.delete(hash)
    this.settle(b, paid)
  }

  // As FiberSession's resolveSent: the listeners hear the end first, and the sent list is written
  // after the round, a moment later.
  private settle(b: Bill, paid: boolean) {
    if (paid) b.shop?.pay(b.hash)
    else this.state.channel!.local += b.amount ?? 0n
    this.ended.set(b.hash, paid)
    for (const fn of this.waiters.get(b.hash) ?? []) fn(paid)
    this.waiters.delete(b.hash)
    setTimeout(() => this.sent.set(b.hash, paid ? { status: 'Paid', preimage: b.preimage } : { status: 'Failed' }), 30)
  }

  whenSent(hash: string) {
    const s = this.sent.get(hash)
    if (s?.status === 'Paid' || s?.status === 'Failed') return Promise.resolve(s.status === 'Paid')
    const b = [...this.net.bills.values()].find((x) => x.hash === hash)
    if (b && this.ended.has(hash)) return Promise.resolve(this.ended.get(hash)!)
    return new Promise<boolean>((resolve) => this.waiters.set(hash, [...(this.waiters.get(hash) ?? []), resolve]))
  }

  async sentPayment(hash: string) {
    return this.sent.get(hash)
  }

  async close() {
    this.state.closing = true
    if (this.closes)
      setImmediate(() => {
        this.state.channel!.closed = true
        this.state.closing = false
      })
  }
}
