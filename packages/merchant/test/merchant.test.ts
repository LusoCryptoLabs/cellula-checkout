// The merchant's rules: invoices, orders asked twice, paid once, paid while away, expiry, webhooks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Merchant } from '../src/merchant.ts'
import { MerchantError } from '../src/errors.ts'
import { shannonsOf, ckbOf } from '../src/amount.ts'
import { verifyWebhook } from '../src/webhook.ts'
import { FakeSession, sleep } from './fake.ts'

const dir = () => mkdtempSync(path.join(tmpdir(), 'merchant-'))
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e) {
    return e instanceof MerchantError ? `${e.code} ${e.status}` : String(e)
  }
}

test('amounts are CKB as written, to 8 decimals, never rounded', () => {
  assert.equal(shannonsOf('5'), 500_000_000n)
  assert.equal(shannonsOf(0.37), 37_000_000n)
  assert.equal(shannonsOf('0.00000001'), 1n)
  assert.equal(ckbOf(37_000_000n), '0.37')
  assert.equal(ckbOf(500_000_000n), '5')
  for (const bad of ['', '1.123456789', '-1', '1e3', 'abc', ' ', NaN as unknown as string]) assert.throws(() => shannonsOf(bad), MerchantError, String(bad))
})

test('an invoice is open, for the amount asked, and readable by id or payment hash', async () => {
  const s = new FakeSession()
  const m = await Merchant.open({ session: s, file: path.join(dir(), 'm.json') })
  const inv = await m.createInvoice({ amount_ckb: '2.5', memo: 'Coffee', order_id: 'A-1', metadata: { sku: 'coffee' } })
  assert.equal(inv.status, 'open')
  assert.equal(inv.amount_shannons, '250000000')
  assert.equal(inv.amount_ckb, '2.5')
  assert.match(inv.id, /^inv_[0-9a-f]{24}$/)
  assert.deepEqual(m.get(inv.payment_hash)?.id, inv.id)
  assert.equal(m.get(inv.id)?.metadata.sku, 'coffee')
  assert.equal(s.starts, 1)
  m.close()
})

test('an order asked for twice gets one invoice; a paid order is not invoiced again', async () => {
  const s = new FakeSession()
  const m = await Merchant.open({ session: s, file: path.join(dir(), 'm.json') })
  const a = await m.createInvoice({ amount_ckb: 3, order_id: 'B-7' })
  const b = await m.createInvoice({ amount_ckb: 3, order_id: 'B-7' })
  assert.equal(a.id, b.id)
  assert.equal(s.invoices.size, 1)
  const other = await m.createInvoice({ amount_ckb: 4, order_id: 'B-7' })
  assert.notEqual(other.id, a.id, 'a new amount is a new invoice')
  s.pay(a.payment_hash)
  await sleep(5)
  assert.equal(await code(m.createInvoice({ amount_ckb: 3, order_id: 'B-7' })), 'order_paid 409')
  m.close()
})

test('refusals: no channel, more than the channel can take, bad input', async () => {
  const s = new FakeSession()
  const m = await Merchant.open({ session: s, file: path.join(dir(), 'm.json') })
  assert.equal(await code(m.createInvoice({ amount_ckb: 1001 })), 'too_large 422')
  assert.equal(await code(m.createInvoice({ amount_ckb: 0 })), 'invalid_amount 400')
  assert.equal(await code(m.createInvoice({ amount_ckb: 1, valid_minutes: 0 })), 'invalid_request 400')
  assert.equal(await code(m.createInvoice({ amount_ckb: 1, memo: 'x'.repeat(201) })), 'invalid_request 400')
  assert.equal(await code(m.createInvoice({ amount_ckb: 1, metadata: { k: 5 as unknown as string } })), 'invalid_request 400')
  s.state.channel = null
  assert.equal(await code(m.createInvoice({ amount_ckb: 1 })), 'not_ready 503')
  assert.equal(m.status().ready, false)
  m.close()
})

test('paid once: the promise, the event and the record, even when the session says it twice', async () => {
  const s = new FakeSession()
  const file = path.join(dir(), 'm.json')
  const m = await Merchant.open({ session: s, file })
  const inv = await m.createInvoice({ amount_ckb: 1, order_id: 'C-1' })
  const seen: string[] = []
  m.on('paid', (i) => seen.push(i.id))
  const waiting = m.waitPaid(inv.id, { timeoutMs: 2000 })
  s.pay(inv.payment_hash, true)
  const paid = await waiting
  await sleep(5)
  assert.equal(paid.status, 'paid')
  assert.ok(paid.paid_at)
  assert.deepEqual(seen, [inv.id])
  assert.equal(m.status().balance_ckb, '1')
  m.close()
  // the record is on disk
  const again = await Merchant.open({ session: s, file })
  assert.equal(again.get(inv.id)?.status, 'paid')
  assert.equal((await again.waitPaid(inv.id)).status, 'paid')
  again.close()
})

test('a payment that arrived while the merchant was down is found when it starts', async () => {
  const s = new FakeSession()
  const file = path.join(dir(), 'm.json')
  const m = await Merchant.open({ session: s, file })
  const inv = await m.createInvoice({ amount_ckb: 2 })
  m.close()
  // the merchant is down; the signer releases on the next start, before anyone listens
  s.invoices.get(inv.payment_hash)!.released = true
  const back = await Merchant.open({ session: new SessionWithoutListeners(s), file })
  assert.equal(back.get(inv.id)?.status, 'paid')
  back.close()
})

// A session restored from disk whose release happened before the merchant listened.
class SessionWithoutListeners extends FakeSession {
  base: FakeSession
  constructor(base: FakeSession) {
    super()
    this.base = base
  }
  override invoiceState(hash: string) {
    return this.base.invoiceState(hash)
  }
}

test('an invoice nobody pays expires after its time and a minute, and says so', async () => {
  let now = 1_000_000
  const s = new FakeSession(() => now)
  const posts: { body: string; sig: string | null }[] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    posts.push({ body: String(init.body), sig: (init.headers as Record<string, string>)['fiber-signature'] ?? null })
    return new Response('ok', { status: 200 })
  }) as typeof globalThis.fetch
  const m = await Merchant.open({ session: s, file: path.join(dir(), 'm.json'), now: () => now, sweepMs: 10, webhook: { url: 'http://shop/hooks', secret: 's3cret' }, fetch })
  const inv = await m.createInvoice({ amount_ckb: 1, valid_minutes: 1 })
  const waiting = m.waitPaid(inv.id)
  now += 60_000 + 30_000
  await sleep(40)
  assert.equal(m.get(inv.id)?.status, 'open', 'still within the grace minute')
  now += 31_000
  assert.equal(await code(waiting), 'expired 410')
  assert.equal(m.get(inv.id)?.status, 'expired')
  await sleep(20)
  assert.equal(posts.length, 1)
  const post = posts[0]!
  const event = JSON.parse(post.body)
  assert.equal(event.type, 'invoice.expired')
  assert.equal(event.data.invoice.id, inv.id)
  assert.ok(verifyWebhook(post.body, post.sig, 's3cret', 300, now))
  m.close()
})

test('a webhook the shop does not take is tried again, and again after a restart', async () => {
  const s = new FakeSession()
  const file = path.join(dir(), 'm.json')
  let answer = 500
  const got: string[] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    got.push(JSON.parse(String(init.body)).type)
    return new Response('', { status: answer })
  }) as typeof globalThis.fetch
  const m = await Merchant.open({ session: s, file, webhook: { url: 'http://shop/hooks', secret: 'k' }, fetch, retryMs: [0, 30, 60_000] })
  const inv = await m.createInvoice({ amount_ckb: 1 })
  s.pay(inv.payment_hash)
  await sleep(80)
  assert.deepEqual(got, ['invoice.paid', 'invoice.paid'], 'at once, then after 30 ms')
  assert.equal(m.webhooksWaiting().length, 1)
  m.close()
  // a restart with the shop taking it now: the kept delivery goes out once its time comes
  answer = 200
  const back = await Merchant.open({ session: s, file, webhook: { url: 'http://shop/hooks', secret: 'k' }, fetch, retryMs: [0, 30, 0], now: () => Date.now() + 120_000 })
  await sleep(40)
  assert.equal(got.length, 3)
  assert.equal(back.webhooksWaiting().length, 0)
  back.close()
})
