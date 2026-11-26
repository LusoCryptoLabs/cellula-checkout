// The webhook signature a shop checks, and the HTTP API a shop's server calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { signWebhook, verifyWebhook } from '../src/webhook.ts'
import { Merchant } from '../src/merchant.ts'
import { serveMerchant } from '../src/http.ts'
import { FakeSession } from './fake.ts'

test('a webhook signature holds for its body, its secret and its time only', () => {
  const body = '{"type":"invoice.paid"}'
  const t = 1_800_000_000
  const sig = signWebhook(body, 'whsec', t)
  assert.match(sig, /^t=1800000000,v1=[0-9a-f]{64}$/)
  assert.ok(verifyWebhook(body, sig, 'whsec', 300, t * 1000))
  assert.ok(!verifyWebhook(body, sig, 'other', 300, t * 1000), 'another secret')
  assert.ok(!verifyWebhook(body + ' ', sig, 'whsec', 300, t * 1000), 'a changed body')
  assert.ok(!verifyWebhook(body, sig, 'whsec', 300, (t + 301) * 1000), 'too old')
  assert.ok(!verifyWebhook(body, sig.replace(/v1=./, 'v1=0'), 'whsec', 300, t * 1000), 'a changed signature')
  for (const bad of [null, '', 't=x,v1=y', 'v1=' + 'a'.repeat(64), `t=${t}`]) assert.ok(!verifyWebhook(body, bad, 'whsec', 300, t * 1000), String(bad))
})

test('the HTTP API: a key is required, invoices are made, read and listed', async () => {
  const s = new FakeSession()
  const m = await Merchant.open({ session: s, file: path.join(mkdtempSync(path.join(tmpdir(), 'merchant-')), 'm.json') })
  const key = 'k'.repeat(32)
  const server = await serveMerchant(m, { port: 0, apiKey: key })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (p: string, init: RequestInit = {}, auth = key) => {
    const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } })
    return { status: r.status, body: await r.json() }
  }
  try {
    assert.deepEqual(await call('/health', {}, ''), { status: 200, body: { ok: true, ready: true } })
    assert.equal((await call('/v1/balance', {}, '')).status, 401)
    assert.equal((await call('/v1/balance', {}, 'wrong'.repeat(5))).status, 401)
    assert.deepEqual((await call('/v1/balance')).body, { ready: true, can_receive_ckb: '1000', balance_ckb: '0' })

    const made = await call('/v1/invoices', { method: 'POST', body: JSON.stringify({ amount_ckb: '1.5', order_id: 'X-1' }) })
    assert.equal(made.status, 201)
    assert.equal(made.body.status, 'open')
    assert.equal((await call(`/v1/invoices/${made.body.id}`)).body.payment_hash, made.body.payment_hash)
    assert.equal((await call(`/v1/invoices/${made.body.payment_hash}`)).body.id, made.body.id)
    assert.equal((await call('/v1/invoices/inv_nothinghere')).status, 404)

    s.pay(made.body.payment_hash)
    await new Promise((r) => setTimeout(r, 5))
    assert.equal((await call(`/v1/invoices/${made.body.id}`)).body.status, 'paid')
    assert.equal((await call('/v1/invoices?status=paid')).body.data.length, 1)
    assert.equal((await call('/v1/invoices?status=open')).body.data.length, 0)
    assert.equal((await call('/v1/invoices?status=nope')).status, 400)

    const again = await call('/v1/invoices', { method: 'POST', body: JSON.stringify({ amount_ckb: '1.5', order_id: 'X-1' }) })
    assert.deepEqual([again.status, again.body.error.code], [409, 'order_paid'])
    const notJson = await fetch(base + '/v1/invoices', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: 'nope' })
    assert.equal(notJson.status, 400)
    assert.equal((await call('/v1/invoices', { method: 'POST', body: JSON.stringify({ amount_ckb: 'lots' }) })).body.error.code, 'invalid_amount')
  } finally {
    server.close()
    m.close()
  }
})
