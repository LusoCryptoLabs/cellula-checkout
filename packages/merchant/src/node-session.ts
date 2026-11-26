// A shop on its own Fiber node (docs/OWN-NODE.md): the merchant's PaySession over the node's
// JSON-RPC, in place of a hosted session on an LSP. The node makes each invoice with a preimage of
// its own and settles it itself, so paid means the node says Paid. What the shop can be paid at
// most is what its peers hold on their side of its ready channels.

import { randomBytes } from 'node:crypto'
import type { PaySession } from './merchant.ts'

export type NodeRpc = {
  /** The node's JSON-RPC, as its config's rpc.listening_addr: http://127.0.0.1:8227 by default. */
  url: string
  /** A Biscuit token, when the node's RPC asks for one. */
  token?: string
  /** Fibt on testnet, Fibb on mainnet. */
  currency?: 'Fibt' | 'Fibb'
  /** How often open invoices and the channels are looked at (ms). */
  pollMs?: number
  fetch?: typeof fetch
}

type RawChannel = { state: { state_name: string }; local_balance: string; remote_balance: string }
const DONE = new Set(['Paid', 'Cancelled', 'Expired'])

export class NodeSession implements PaySession {
  state: { channel: { ready: boolean; closed: boolean; local: bigint; remote: bigint } | null } = { channel: null }
  private watched = new Map<string, { amount: bigint; status: string }>()
  private listeners = new Set<(hash: string, amount: bigint) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private n = 0

  private rpc: NodeRpc

  constructor(rpc: NodeRpc) {
    this.rpc = rpc
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const r = await (this.rpc.fetch ?? fetch)(this.rpc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.rpc.token ? { authorization: `Bearer ${this.rpc.token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params: [params] }),
    })
    const body = (await r.json()) as { result?: T; error?: { message?: string } }
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
    return body.result as T
  }

  /** Reads the node's channels and starts looking at open invoices. */
  async start(): Promise<void> {
    await this.channels()
    if (this.timer) return
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.rpc.pollMs ?? 3000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Invoices made before this process started: what the node says of each now. */
  async resume(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      try {
        const r = await this.call<{ status: string; invoice: { amount?: string | null } }>('get_invoice', { payment_hash: hash })
        this.watched.set(hash, { amount: BigInt(r.invoice.amount ?? '0x0'), status: r.status })
      } catch {
        // Not this node's invoice, or the node forgot it: nothing to say of it.
      }
    }
  }

  private async channels() {
    const { channels } = await this.call<{ channels: RawChannel[] }>('list_channels', {})
    const ready = channels.filter((c) => c.state.state_name === 'ChannelReady')
    this.state.channel = ready.length
      ? {
          ready: true,
          closed: false,
          local: ready.reduce((s, c) => s + BigInt(c.local_balance), 0n),
          remote: ready.reduce((s, c) => s + BigInt(c.remote_balance), 0n),
        }
      : null
  }

  async invoice(amount: bigint, o: { description?: string; validMs?: number } = {}) {
    const c = this.state.channel
    if (!c?.ready) throw new Error('no ready channel to be paid into')
    if (amount > c.remote) throw new Error(`the channel can take ${c.remote} now`)
    const validMs = o.validMs ?? 3_600_000
    const r = await this.call<{ invoice_address: string; invoice: { data: { payment_hash: string } } }>('new_invoice', {
      amount: `0x${amount.toString(16)}`,
      currency: this.rpc.currency ?? 'Fibt',
      payment_preimage: `0x${randomBytes(32).toString('hex')}`,
      description: o.description,
      expiry: `0x${Math.ceil(validMs / 1000).toString(16)}`,
    })
    const paymentHash = r.invoice.data.payment_hash
    this.watched.set(paymentHash, { amount, status: 'Open' })
    return { paymentHash, invoice: r.invoice_address, expiresAt: Date.now() + validMs }
  }

  /** This node's public key (renting room, room.ts). */
  async pubkey(): Promise<string> {
    const info = await this.call<{ node_id?: string; pubkey?: string }>('node_info', {})
    return String(info.node_id ?? info.pubkey ?? '')
  }

  /** Pay an invoice from the node; resolves once the node says it succeeded. */
  async pay(invoice: string): Promise<void> {
    const sent = await this.call<{ payment_hash: string }>('send_payment', { invoice })
    for (let i = 0; i < 60; i++) {
      const p = await this.call<{ status: string; failed_error?: string }>('get_payment', { payment_hash: sent.payment_hash })
      if (p.status === 'Success') return
      if (p.status === 'Failed') throw new Error(`the node's payment failed: ${p.failed_error ?? 'no reason given'}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error('the node did not finish the payment in two minutes')
  }

  /** Open a channel to `pubkey` with `ckb` CKB from the node's wallet (the node signs it). */
  async openChannel(pubkey: string, ckb: bigint): Promise<void> {
    await this.call('open_channel', { pubkey, funding_amount: `0x${(ckb * 100_000_000n).toString(16)}`, public: false })
  }

  onPaid(fn: (hash: string, amount: bigint) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  invoiceState(hash: string) {
    const w = this.watched.get(hash)
    return w && { status: w.status, released: w.status === 'Paid' }
  }

  private ticks = 0
  private async tick() {
    if (++this.ticks % 10 === 0) await this.channels()
    for (const [hash, w] of this.watched) {
      if (DONE.has(w.status)) continue
      const r = await this.call<{ status: string }>('get_invoice', { payment_hash: hash })
      if (r.status === w.status) continue
      w.status = r.status
      if (r.status === 'Paid') {
        await this.channels()
        for (const fn of this.listeners) fn(hash, w.amount)
      }
    }
  }
}
