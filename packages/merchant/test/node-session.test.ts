// A shop on its own Fiber node (node-session.ts): invoices made and settled by that node, paid once
// the node says Paid, also when that happened while the shop's process was down.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Merchant } from '../src/merchant.ts'
import { NodeSession } from '../src/node-session.ts'
import { SHANNONS } from '../src/amount.ts'

const dir = () => mkdtempSync(path.join(tmpdir(), 'own-node-'))

/** An fnn's JSON-RPC, as much as the session asks of it. */
function fakeNode() {
  const invoices = new Map<string, { amount: bigint; status: string; preimage: string }>()
  const calls: string[] = []
  let n = 0
  let ready = true
  const fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const req = JSON.parse(init.body)
    calls.push(`${req.method}${init.headers.authorization ? ' with token' : ''}`)
    const p = req.params[0]
    let result: unknown
    if (req.method === 'list_channels')
      result = { channels: [{ state: { state_name: ready ? 'ChannelReady' : 'Closed' }, local_balance: `0x${(2n * SHANNONS).toString(16)}`, remote_balance: `0x${(89n * SHANNONS).toString(16)}` }] }
    else if (req.method === 'new_invoice') {
      const hash = `0x${(++n).toString(16).padStart(64, '0')}`
      invoices.set(hash, { amount: BigInt(p.amount), status: 'Open', preimage: p.payment_preimage })
      result = { invoice_address: `fibt${n}`, invoice: { amount: p.amount, data: { payment_hash: hash } } }
    } else if (req.method === 'get_invoice') {
      const i = invoices.get(p.payment_hash)
      if (!i) return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { message: 'not found' } }))
      result = { status: i.status, invoice: { amount: `0x${i.amount.toString(16)}` } }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
  }) as unknown as typeof globalThis.fetch
  return { fetch, invoices, calls, close: () => (ready = false) }
}

test("an invoice is made by the shop's node with a preimage of its own, and paid once the node says so", async () => {
  const node = fakeNode()
  const session = new NodeSession({ url: 'http://node', token: 't', fetch: node.fetch, pollMs: 10 })
  const m = await Merchant.open({ session, file: path.join(dir(), 'merchant.json') })
  assert.deepEqual(m.status(), { ready: true, can_receive_ckb: '89', balance_ckb: '2' })
  const inv = await m.createInvoice({ amount_ckb: '1.5', order_id: 'o1' })
  const kept = node.invoices.get(inv.payment_hash)!
  assert.equal(kept.amount, 150_000_000n)
  assert.match(kept.preimage, /^0x[0-9a-f]{64}$/)
  assert.ok(node.calls.every((c) => c.endsWith('with token')), 'the token goes with every call')
  const paid = m.waitPaid(inv.id, { timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(m.get(inv.id)!.status, 'open', 'not paid until the node says so')
  kept.status = 'Paid'
  assert.equal((await paid).status, 'paid')
  session.stop()
  m.close()
})

test('paid while the process was down: found on the next start', async () => {
  const node = fakeNode()
  const file = path.join(dir(), 'merchant.json')
  const first = new NodeSession({ url: 'http://node', fetch: node.fetch, pollMs: 10_000 })
  const m1 = await Merchant.open({ session: first, file })
  const inv = await m1.createInvoice({ amount_ckb: 3 })
  first.stop()
  m1.close()
  node.invoices.get(inv.payment_hash)!.status = 'Paid'
  // Control first: another node's invoice is not taken as paid.
  const other = fakeNode()
  const m0 = await Merchant.open({ session: new NodeSession({ url: 'http://other', fetch: other.fetch, pollMs: 10_000 }), file })
  assert.equal(m0.get(inv.id)!.status, 'open')
  m0.close()
  const m2 = await Merchant.open({ session: new NodeSession({ url: 'http://node', fetch: node.fetch, pollMs: 10_000 }), file })
  assert.equal(m2.get(inv.id)!.status, 'paid')
  m2.close()
})

test('no ready channel: no invoice', async () => {
  const node = fakeNode()
  node.close()
  const session = new NodeSession({ url: 'http://node', fetch: node.fetch, pollMs: 10_000 })
  const m = await Merchant.open({ session, file: path.join(dir(), 'merchant.json') })
  assert.equal(m.status().ready, false)
  await assert.rejects(m.createInvoice({ amount_ckb: 1 }), /no open channel/)
  session.stop()
  m.close()
})
