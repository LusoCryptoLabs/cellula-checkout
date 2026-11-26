// A Fiber session that pays when told: what the merchant needs of FiberSession, without a chain.

import type { PaySession } from '../src/merchant.ts'
import { SHANNONS } from '../src/amount.ts'

export class FakeSession implements PaySession {
  state = { channel: { ready: true, closed: false, local: 0n, remote: 1000n * SHANNONS } as { ready: boolean; closed: boolean; local: bigint; remote: bigint } | null, feeDue: 0n }
  invoices = new Map<string, { amount: bigint; released: boolean }>()
  /** The LSP's opening fee: payOpeningFee calls, how many of the next ones fail, and a gate that
   * holds the next one until it opens. */
  fees = 0
  feeFails = 0
  feeGate: Promise<void> | null = null
  private changes = new Set<() => void>()
  private listeners = new Set<(hash: string, amount: bigint) => void>()
  private n = 0
  starts = 0
  now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  async start() {
    this.starts++
  }

  async invoice(amount: bigint, o: { description?: string; validMs?: number } = {}) {
    const c = this.state.channel
    if (!c?.ready) throw new Error('no ready channel to be paid into')
    if (this.state.feeDue > 0n) throw new Error(`pay the opening fee (${this.state.feeDue} shannons) first`)
    if (amount > c.remote) throw new Error(`the channel can take ${c.remote} now`)
    const paymentHash = `0x${(++this.n).toString(16).padStart(64, '0')}`
    this.invoices.set(paymentHash, { amount, released: false })
    return { paymentHash, invoice: `fibt${amount}fake${this.n}`, expiresAt: this.now() + (o.validMs ?? 3_600_000) }
  }

  onPaid(fn: (hash: string, amount: bigint) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  subscribe(fn: () => void) {
    this.changes.add(fn)
    return () => this.changes.delete(fn)
  }

  /** The state changed, as the session says to its listeners. */
  changed() {
    for (const fn of this.changes) fn()
  }

  /** As FiberSession.payOpeningFee: paid from the channel, resolved once the gateway has seen it. */
  async payOpeningFee() {
    this.fees++
    await this.feeGate
    if (this.feeFails > 0) {
      this.feeFails--
      throw new Error('the LSP answered 503')
    }
    const due = this.state.feeDue
    if (!due) return null
    this.state.channel!.local -= due
    this.state.feeDue = 0n
    this.changed()
    return `0x${'fe'.repeat(32)}`
  }

  invoiceState(hash: string) {
    const i = this.invoices.get(hash)
    return i && { status: i.released ? 'Paid' : 'Open', released: i.released }
  }

  /** The payer's money arrives and the signer releases the secret; `twice` repeats the call, as a
   * restart may. */
  pay(hash: string, twice = false) {
    const i = this.invoices.get(hash)
    if (!i) throw new Error(`no invoice ${hash}`)
    i.released = true
    this.state.channel!.local += i.amount
    this.state.channel!.remote -= i.amount
    for (let k = 0; k < (twice ? 2 : 1); k++) for (const fn of this.listeners) fn(hash, i.amount)
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
