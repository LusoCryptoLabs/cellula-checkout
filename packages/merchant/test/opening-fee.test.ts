// LSP2's opening fee, once per wallet (since 2026-10-25 the merchant kit pays it too, as the
// wallet's session does): until it is paid the LSP takes no payment into the channel and the session
// makes no invoice. The merchant pays it as soon as the channel is ready, once, and tries again a
// minute after a failure.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Merchant, type PaySession } from '../src/merchant.ts'
import { MerchantError } from '../src/errors.ts'
import { SHANNONS } from '../src/amount.ts'
import { serveMerchant } from '../src/http.ts'
import { FakeSession, sleep } from './fake.ts'

const FEE = 500n * SHANNONS
const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'merchant-fee-')), 'm.json')
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e) {
    return e instanceof MerchantError ? `${e.code} ${e.status}` : String(e)
  }
}
// A channel just opened with 10 CKB to spend and the fee on top (the 99 set aside are not in it).
function opening() {
  const s = new FakeSession()
  s.state.channel = { ready: false, closed: false, local: 10n * SHANNONS + FEE, remote: 200n * SHANNONS }
  s.state.feeDue = FEE
  return s
}

test('a new channel pays the opening fee once it is ready, then makes invoices', async () => {
  const s = opening()
  const m = await Merchant.open({ session: s, file: file() })
  assert.equal(s.fees, 0, 'not before the channel is ready')
  assert.equal(m.waitsForFee(), false, 'a channel not ready yet waits for itself first')
  assert.equal(m.status().ready, false)
  s.state.channel!.ready = true
  s.changed()
  await m.payOpeningFee()
  assert.equal(s.fees, 1)
  assert.equal(s.state.feeDue, 0n)
  assert.deepEqual(m.status(), { ready: true, can_receive_ckb: '200', balance_ckb: '10' })
  assert.equal((await m.createInvoice({ amount_ckb: 2, order_id: 'F-1' })).status, 'open')
  s.changed()
  await m.payOpeningFee()
  assert.equal(s.fees, 1, 'once')
  m.close()
})

test('while the fee is being paid it is paid once, and an invoice asked meanwhile is not_ready', async () => {
  const s = opening()
  s.state.channel!.ready = true
  let open!: () => void
  s.feeGate = new Promise((r) => (open = r))
  const m = await Merchant.open({ session: s, file: file() })
  assert.equal(s.fees, 1, 'paid as the merchant starts on a ready channel')
  for (let i = 0; i < 5; i++) s.changed()
  assert.equal(s.fees, 1, 'one payment under way, not one per change')
  const asked = await code(m.createInvoice({ amount_ckb: 1 }))
  assert.equal(asked, 'not_ready 503')
  assert.equal(s.invoices.size, 0, 'no invoice the LSP would refuse to be paid')
  open()
  await m.payOpeningFee()
  assert.equal((await m.createInvoice({ amount_ckb: 1 })).status, 'open')
  assert.equal(s.fees, 1)
  m.close()
})

test('a fee payment that fails is tried again a minute later, not at every change', async () => {
  let now = 1_800_000_000_000
  const s = opening()
  s.state.channel!.ready = true
  s.feeFails = 1
  const lines: string[] = []
  const m = await Merchant.open({ session: s, file: file(), now: () => now, log: (l) => lines.push(l) })
  await m.payOpeningFee()
  assert.equal(s.fees, 1)
  assert.ok(lines.some((l) => /opening fee not paid.*503/.test(l)), lines.join('\n'))
  s.changed()
  s.changed()
  await m.payOpeningFee()
  assert.equal(s.fees, 1, 'not again at once')
  assert.equal(await code(m.createInvoice({ amount_ckb: 1 })), 'not_ready 503')
  assert.equal(m.waitsForFee(), true, 'waiting for its fee, not closed (the shop page keeps asking)')
  now += 60_000
  s.changed()
  await m.payOpeningFee()
  assert.equal(s.fees, 2)
  assert.equal(s.state.feeDue, 0n)
  assert.equal(m.waitsForFee(), false)
  assert.equal((await m.createInvoice({ amount_ckb: 1 })).status, 'open')
  m.close()
})

test('controls: nothing due, or a session that pays none (a shop on its own node), is never asked', async () => {
  const s = new FakeSession()
  const m = await Merchant.open({ session: s, file: file() })
  s.changed()
  await m.payOpeningFee()
  assert.equal(s.fees, 0)
  assert.equal((await m.createInvoice({ amount_ckb: 1 })).status, 'open')
  m.close()
  // Its own node's session has no fee and no payOpeningFee (node-session.ts).
  const own: PaySession = { start: async () => {}, invoice: s.invoice.bind(s), onPaid: s.onPaid.bind(s), invoiceState: s.invoiceState.bind(s), state: { channel: s.state.channel } }
  const m2 = await Merchant.open({ session: own, file: file() })
  await m2.payOpeningFee()
  assert.equal(m2.status().ready, true)
  assert.equal((await m2.createInvoice({ amount_ckb: 1 })).status, 'open')
  m2.close()
})

test('over HTTP, as the e2e asks: not ready while the fee is due, then an invoice paid', async () => {
  const s = opening()
  let open!: () => void
  s.feeGate = new Promise((r) => (open = r))
  const m = await Merchant.open({ session: s, file: file() })
  const key = 'k'.repeat(32)
  const server = await serveMerchant(m, { port: 0, apiKey: key })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } })
    return { status: r.status, body: await r.json() }
  }
  try {
    s.state.channel!.ready = true
    s.changed()
    assert.deepEqual((await call('/health')).body, { ok: true, ready: false })
    const early = await call('/v1/invoices', { method: 'POST', body: JSON.stringify({ amount_ckb: '0.5', order_id: 'e2e-1' }) })
    assert.deepEqual([early.status, early.body.error.code], [503, 'not_ready'])
    assert.match(early.body.error.message, /opening fee/)
    open()
    await m.payOpeningFee()
    assert.deepEqual((await call('/v1/balance')).body, { ready: true, can_receive_ckb: '200', balance_ckb: '10' })
    const made = await call('/v1/invoices', { method: 'POST', body: JSON.stringify({ amount_ckb: '0.5', order_id: 'e2e-1' }) })
    assert.equal(made.status, 201)
    s.pay(made.body.payment_hash)
    await sleep(5)
    assert.equal((await call(`/v1/invoices/${made.body.id}`)).body.status, 'paid')
    assert.equal((await call('/v1/balance')).body.balance_ckb, '10.5')
  } finally {
    server.close()
    m.close()
  }
})
