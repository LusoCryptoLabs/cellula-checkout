// HTTP 402 over Fiber: a seller's paywall answers with an invoice, an agent pays it and asks again
// with the invoice and its preimage, and the seller lets that request through once.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Merchant } from '../src/merchant.ts'
import { Agent } from '../src/agent.ts'
import { MerchantError } from '../src/errors.ts'
import { paywall, fetchPaid, decode, encode, Receipts, type PaymentRequired, type PaymentPayload, type SettlementResponse, type PayInvoice } from '../src/x402.ts'
import { FakeNet, FakePayer, FakeShop } from './fake-payer.ts'

const dir = () => mkdtempSync(path.join(tmpdir(), 'x402-'))
const PAY_TO = '02' + 'ab'.repeat(32)
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e) {
    return e instanceof MerchantError ? `${e.code} ${e.status}` : String(e)
  }
}

async function world(o: { price?: string; network?: string; paidWaitMs?: number } = {}) {
  const net = new FakeNet()
  const shop = new FakeShop(net)
  const d = dir()
  const m = await Merchant.open({ session: shop, file: path.join(d, 'm.json') })
  const gate = paywall(m, { price_ckb: o.price ?? '0.1', payTo: PAY_TO, network: o.network, description: 'A name report', receipts: new Receipts(path.join(d, 'used.json')), paidWaitMs: o.paidWaitMs ?? 200 })
  let served = 0
  const server = http.createServer(async (req, res) => {
    if (!(await gate(req, res))) return
    served++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: 'maria.cell', owner: 'ckt1q...' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/names/maria.cell`
  const payer = new FakePayer(net)
  const agent = await Agent.open({ session: payer, file: path.join(d, 'agent.json'), caps: { per_payment_ckb: 1 } })
  const pay: PayInvoice = async (invoice, maxCkb) => {
    const p = await agent.pay({ invoice, max_ckb: maxCkb ?? undefined })
    return { payment_hash: p.payment_hash, amount_ckb: p.amount_ckb, preimage: p.preimage, status: p.status }
  }
  return { net, shop, m, server, url, payer, agent, pay, served: () => served, close: () => new Promise((r) => server.close(r)) }
}

test('an unpaid request is answered 402 with a Fiber invoice in the x402 v2 shape', async () => {
  const w = await world()
  try {
    const r = await fetch(w.url)
    assert.equal(r.status, 402)
    const required = decode<PaymentRequired>(r.headers.get('payment-required'))!
    assert.equal(required.x402Version, 2)
    assert.equal(required.resource.url, w.url)
    const a = required.accepts[0]!
    assert.deepEqual({ scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo }, { scheme: 'exact', network: 'fiber:testnet', asset: 'ckb', amount: '10000000', payTo: PAY_TO })
    assert.match(String(a.extra.invoice), /^fibt/)
    assert.deepEqual(await r.json(), required, 'the body says the same, for clients that read bodies')
    assert.equal(w.m.list()[0]?.invoice, a.extra.invoice, 'the invoice is one the shop made')
    assert.equal(w.served(), 0)
  } finally {
    await w.close()
  }
})

test('the agent pays the 402 and the request goes through, once per receipt', async () => {
  const w = await world()
  try {
    const r = await fetchPaid(w.url, {}, w.pay)
    assert.equal(r.response.status, 200)
    assert.deepEqual(await r.response.json(), { name: 'maria.cell', owner: 'ckt1q...' })
    assert.equal(r.paid?.amount_ckb, '0.1')
    const settled = decode<SettlementResponse>(r.response.headers.get('payment-response'))!
    assert.equal(settled.success, true)
    assert.equal(settled.transaction, `fiber-receipt:${r.paid?.payment_hash}`)
    assert.equal(w.m.get(r.paid!.payment_hash)?.status, 'paid')
    assert.equal(w.served(), 1)

    // The same receipt again is refused: one request each.
    const inv = w.m.get(r.paid!.payment_hash)!
    const offer = { scheme: 'exact', network: 'fiber:testnet', asset: 'ckb', amount: '10000000', payTo: PAY_TO, maxTimeoutSeconds: 600, extra: { invoice: inv.invoice } }
    const replay = encode({ x402Version: 2, accepted: offer, payload: { invoice: inv.invoice, paymentPreimage: r.paid!.preimage } } satisfies PaymentPayload)
    const again = await fetch(w.url, { headers: { 'PAYMENT-SIGNATURE': replay } })
    assert.equal(again.status, 402)
    assert.equal(decode<SettlementResponse>(again.headers.get('payment-response'))?.errorReason, 'receipt_used')
    assert.equal(w.served(), 1)

    // A second paid request pays a new invoice.
    assert.equal((await fetchPaid(w.url, {}, w.pay)).response.status, 200)
    assert.equal(w.served(), 2)
    assert.equal(w.agent.status().spent_ckb, '0.2')
  } finally {
    await w.close()
  }
})

test('the request with the receipt is sent again when it does not reach the seller, and nothing is paid twice', async () => {
  const w = await world()
  try {
    // The paid request fails twice on the way (a dropped connection), then gets through.
    let drops = 2
    const flaky: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).has('PAYMENT-SIGNATURE') && drops-- > 0) throw new TypeError('fetch failed')
      return fetch(input, init)
    }
    const r = await fetchPaid(w.url, {}, w.pay, { fetch: flaky })
    assert.equal(r.response.status, 200)
    assert.equal(w.served(), 1)
    assert.equal(w.payer.pays.length, 1, 'paid once')

    // Control: a seller that never gets the paid request: one payment, and the error says it.
    const dead: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) throw new TypeError('fetch failed')
      return fetch(input, init)
    }
    const failed = await fetchPaid(w.url, {}, w.pay, { fetch: dead }).then(
      () => null,
      (e) => e as MerchantError,
    )
    assert.equal(failed?.code, 'unreachable')
    assert.match(failed!.message, /^paid 0\.1 CKB \(0x[0-9a-f]{64}, receipt 0x[0-9a-f]{64}\), but the request that carries the receipt did not reach the seller after 3 tries/)
    assert.equal(w.payer.pays.length, 2, 'that one paid once too, not once per try')
    assert.equal(w.served(), 1)
  } finally {
    await w.close()
  }
})

test('a receipt that does not pay this request is refused, and the route is not served', async () => {
  const w = await world()
  try {
    const first = await fetch(w.url)
    const offer = decode<PaymentRequired>(first.headers.get('payment-required'))!.accepts[0]!
    const inv = w.m.list()[0]!
    const tries: [string, PaymentPayload][] = [
      ['invalid_preimage', { x402Version: 2, accepted: offer, payload: { invoice: inv.invoice, paymentPreimage: 'nope' } }],
      ['invoice_unknown', { x402Version: 2, accepted: offer, payload: { invoice: inv.invoice, paymentPreimage: '0x' + '11'.repeat(32) } }],
      ['amount_mismatch', { x402Version: 2, accepted: { ...offer, amount: '1' }, payload: { invoice: inv.invoice, paymentPreimage: '0x' + '11'.repeat(32) } }],
      ['unsupported_network', { x402Version: 2, accepted: { ...offer, network: 'eip155:8453' }, payload: { invoice: inv.invoice, paymentPreimage: '0x' + '11'.repeat(32) } }],
      ['pay_to_mismatch', { x402Version: 2, accepted: { ...offer, payTo: '03' + 'cd'.repeat(32) }, payload: { invoice: inv.invoice, paymentPreimage: '0x' + '11'.repeat(32) } }],
      ['invalid_payload', { x402Version: 1, accepted: offer, payload: {} } as PaymentPayload],
    ]
    for (const [reason, payload] of tries) {
      const r = await fetch(w.url, { headers: { 'PAYMENT-SIGNATURE': encode(payload) } })
      assert.equal(r.status, 402, reason)
      assert.equal(decode<SettlementResponse>(r.headers.get('payment-response'))?.errorReason, reason)
    }
    // The right preimage for an invoice nobody paid: the shop never saw it paid.
    const bill = w.net.bills.get(inv.invoice)!
    const unpaid = await fetch(w.url, { headers: { 'PAYMENT-SIGNATURE': encode({ x402Version: 2, accepted: offer, payload: { invoice: inv.invoice, paymentPreimage: bill.preimage } } satisfies PaymentPayload) } })
    assert.equal(decode<SettlementResponse>(unpaid.headers.get('payment-response'))?.errorReason, 'not_paid')
    assert.equal(w.served(), 0)
    // Control: the same invoice, once paid, opens the route.
    w.shop.pay(bill.hash)
    const ok = await fetch(w.url, { headers: { 'PAYMENT-SIGNATURE': encode({ x402Version: 2, accepted: offer, payload: { invoice: inv.invoice, paymentPreimage: bill.preimage } } satisfies PaymentPayload) } })
    assert.equal(ok.status, 200)
    assert.equal(w.served(), 1)
  } finally {
    await w.close()
  }
})

test('a 402 the agent cannot pay is refused before anything is paid', async () => {
  const other = await world({ network: 'fiber:mainnet' })
  try {
    assert.equal(await code(fetchPaid(other.url, {}, other.pay)), 'not_payable 422', 'another network')
    assert.equal(other.payer.pays.length, 0)
  } finally {
    await other.close()
  }
  const dear = await world({ price: '2' })
  try {
    assert.equal(await code(fetchPaid(dear.url, {}, dear.pay, { max_ckb: '1' })), 'over_cap 422', "over the request's own limit")
    assert.equal(await code(fetchPaid(dear.url, {}, dear.pay)), 'over_cap 422', "over the agent's per-payment cap")
    assert.equal(dear.payer.pays.length, 0)
  } finally {
    await dear.close()
  }
  // A seller whose requirement says less than its invoice asks.
  const net = new FakeNet()
  const liar = http.createServer((_req, res) => {
    const required: PaymentRequired = { x402Version: 2, resource: { url: 'x' }, accepts: [{ scheme: 'exact', network: 'fiber:testnet', asset: 'ckb', amount: '1000', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { invoice: net.bill(100_000_000n).invoice } }] }
    res.writeHead(402, { 'PAYMENT-REQUIRED': encode(required) })
    res.end('{}')
  })
  await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r))
  try {
    const payer = new FakePayer(net)
    const agent = await Agent.open({ session: payer, file: path.join(dir(), 'a.json') })
    const pay: PayInvoice = async (invoice, maxCkb) => {
      const p = await agent.pay({ invoice, max_ckb: maxCkb ?? undefined })
      return { payment_hash: p.payment_hash, amount_ckb: p.amount_ckb, preimage: p.preimage, status: p.status }
    }
    assert.equal(await code(fetchPaid(`http://127.0.0.1:${(liar.address() as AddressInfo).port}/`, {}, pay)), 'over_cap 422', 'the invoice asks 1 CKB, the requirement 0.00001')
    assert.equal(payer.pays.length, 0)
  } finally {
    await new Promise((r) => liar.close(r))
  }
})

test('a route that asks nothing is fetched as it is', async () => {
  const free = http.createServer((_req, res) => res.end('free'))
  await new Promise<void>((r) => free.listen(0, '127.0.0.1', r))
  try {
    let paid = 0
    const r = await fetchPaid(`http://127.0.0.1:${(free.address() as AddressInfo).port}/`, {}, async () => {
      paid++
      throw new Error('never asked')
    })
    assert.equal(await r.response.text(), 'free')
    assert.equal(r.paid, null)
    assert.equal(paid, 0)
  } finally {
    await new Promise((r) => free.close(r))
  }
})

test('one receipt opens one request across all the paywalls of a shop', async () => {
  const net = new FakeNet()
  const shop = new FakeShop(net)
  const d = dir()
  const m = await Merchant.open({ session: shop, file: path.join(d, 'm.json') })
  const receipts = new Receipts(path.join(d, 'used.json'))
  const a = paywall(m, { price_ckb: '0.1', payTo: PAY_TO, receipts })
  const b = paywall(m, { price_ckb: '0.1', payTo: PAY_TO, receipts })
  const inv = await m.createInvoice({ amount_ckb: '0.1' })
  const bill = net.bills.get(inv.invoice)!
  shop.pay(bill.hash)
  const offer = { scheme: 'exact', network: 'fiber:testnet', asset: 'ckb', amount: '10000000', payTo: PAY_TO, maxTimeoutSeconds: 600, extra: { invoice: inv.invoice } }
  const header = encode({ x402Version: 2, accepted: offer, payload: { invoice: inv.invoice, paymentPreimage: bill.preimage } } satisfies PaymentPayload)
  assert.deepEqual(await a.verify(header), { ok: true, paymentHash: bill.hash })
  assert.ok(await receipts.use(bill.hash))
  assert.deepEqual(await b.verify(header), { ok: false, reason: 'receipt_used' }, 'the other route refuses it')
  assert.equal(await receipts.use(bill.hash), false)
  // Kept across a restart.
  assert.ok(new Receipts(path.join(d, 'used.json')).has(bill.hash))
})
