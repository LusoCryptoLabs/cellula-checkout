// The agent and the person's phone through the relay, end to end in one process: a payment waits,
// the person's wallet signs on the page's behalf, the agent pays; refusing, stopping, letting it pay
// again and taking out the same way. Then a relay that lies: answers it invents, signatures by
// another key, a command played twice or too late. None of those moves the agent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { ccc } from '@ckb-ccc/core'
import { relayHandler, type RelayState } from '../src/relay.ts'
import { Agent } from '../../../packages/merchant/src/agent.ts'
import { Phone } from '../../../packages/merchant/src/agent-phone.ts'
import { agentMark, commandMessage, phoneToken } from '../../../packages/merchant/src/phone-sign.ts'
import { FakeNet, FakePayer } from '../../../packages/merchant/test/fake-payer.ts'

const client = new ccc.ClientPublicTestnet()
const person = new ccc.SignerCkbPrivateKey(client, '0x' + '11'.repeat(32))
const stranger = new ccc.SignerCkbPrivateKey(client, '0x' + '22'.repeat(32))
const AGENT = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqt5d97mu8h66t9h9y0ys02p8deqcczfm0gqtst4v'
const RETURN_TO = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2tu2x3nscv26nsmz5z6a6fe50sk8kapqge4yqyh'
const SECRET = 'cd'.repeat(32)
const TOKEN = phoneToken(SECRET)
const ckb = (n: number) => BigInt(Math.round(n * 1e8))
const sigOf = async (s: ccc.SignerCkbPrivateKey, m: string) => {
  const x = await s.signMessage(m)
  return { signature: x.signature, identity: x.identity, signType: x.signType }
}
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e: any) {
    return `${e.code} ${e.status}`
  }
}

async function setup(o: { fetch?: typeof fetch } = {}) {
  const state: RelayState = { agents: {} }
  const server = http.createServer(relayHandler({ state, client, origins: [], addressPrefix: 'ckt' }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const d = mkdtempSync(path.join(tmpdir(), 'phone-'))
  const file = path.join(d, 'phone.json')
  writeFileSync(file, JSON.stringify({ token: TOKEN, secret: SECRET }))
  const net = new FakeNet()
  const payer = new FakePayer(net)
  const swept: string[] = []
  const approver = await person.getRecommendedAddress()
  const agent = await Agent.open({ session: payer, file: path.join(d, 'a.json'), caps: { per_payment_ckb: 2, total_ckb: 10 }, approveAboveCkb: '0.5', returnTo: RETURN_TO, sweep: async (to) => (swept.push(to), '0xswept'), closeWaitMs: 2_000, waitMs: 2_000, phone: true })
  const phone = new Phone({ agent, relay, page: 'https://testnet.cellula.id/agent', token: TOKEN, secret: SECRET, address: AGENT, approver, returnTo: RETURN_TO, client, file, fetch: o.fetch, statusMs: 0 })
  // The person's page: read what waits, have the wallet sign, hand the signature to the relay.
  const page = {
    view: async () => (await fetch(`${relay}/v1/agents/${TOKEN}`)).json() as Promise<any>,
    answer: async (message: string, signer = person) =>
      (await fetch(`${relay}/v1/agents/${TOKEN}/answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature: await sigOf(signer, message) }) })).status,
  }
  return { relay, net, payer, agent, phone, page, swept, file, close: () => new Promise((r) => server.close(r)) }
}

test('approved on the phone, the payment goes; refused there, it does not', async () => {
  const s = await setup()
  try {
    const bill = s.net.bill(ckb(1))
    const asked = await code(s.agent.pay({ invoice: bill.invoice, memo: 'a bundle' }))
    assert.equal(asked, 'needs_approval 403')
    assert.equal(s.phone.url(), `https://testnet.cellula.id/agent#phone=${TOKEN}.${agentMark(AGENT)}`)
    await s.phone.round()
    const view = await s.page.view()
    assert.equal(view.agent, AGENT)
    assert.equal(view.status.waiting_approvals, 1)
    const ask = view.asks[0]
    assert.match(ask.messages.approve, /^Cellula agent: approve this payment\nAgent: ckt1/)
    assert.equal(await s.page.answer(ask.messages.approve), 200)
    await s.phone.round()
    assert.equal(s.agent.approvals()[0]!.status, 'approved')
    assert.equal((await s.agent.pay({ invoice: bill.invoice, memo: 'a bundle' })).status, 'paid')

    const other = s.net.bill(ckb(1.5))
    await code(s.agent.pay({ invoice: other.invoice }))
    await s.phone.round()
    const second = (await s.page.view()).asks.find((a: any) => a.answered === null)
    assert.equal(await s.page.answer(second.messages.refuse), 200)
    await s.phone.round()
    assert.equal(await code(s.agent.pay({ invoice: other.invoice })), 'refused_by_person 403')
    assert.equal(s.payer.pays.length, 1)
  } finally {
    await s.phone.stop()
    await s.close()
  }
})

test('stopped, let pay again and taken out from the phone, each once, to the return address only', async () => {
  const s = await setup()
  try {
    await s.phone.round()
    const stop = commandMessage(AGENT, 'stop', Date.now(), '0123456789abcdef')
    assert.equal(await s.page.answer(stop), 200)
    await s.phone.round()
    assert.equal(s.agent.status().paused, true)
    assert.equal(await code(s.agent.pay({ invoice: s.net.bill(ckb(0.1)).invoice })), 'paused 423')
    assert.equal(await s.page.answer(commandMessage(AGENT, 'resume', Date.now(), '0123456789abcdee', undefined, s.agent.status().paused_id!)), 200)
    await s.phone.round()
    assert.equal(s.agent.status().paused, false)
    assert.equal(await s.page.answer(commandMessage(AGENT, 'take-out', Date.now(), '0123456789abcded', RETURN_TO)), 200)
    await s.phone.round()
    assert.equal((await s.agent.takenOut())?.status, 'returned')
    assert.deepEqual(s.swept, [RETURN_TO])
    await s.phone.round()
    assert.equal((await s.page.view()).status.take_out.status, 'returned', 'the page sees it on the next round')
  } finally {
    await s.phone.stop()
    await s.close()
  }
})

test('a relay that lies moves nothing: invented answers, another key, a command played twice or too late', async () => {
  // A relay that serves its own answers to the agent, whatever the person signed.
  let served: { seq: number; message: string; signature: unknown }[] = []
  const lying: typeof fetch = async (input, init) => {
    const u = String(input)
    if (u.includes('/answers')) return new Response(JSON.stringify({ answers: served }), { status: 200 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const s = await setup({ fetch: lying })
  try {
    const bill = s.net.bill(ckb(1))
    await code(s.agent.pay({ invoice: bill.invoice }))
    const facts = s.agent.approvals()[0]!
    const { askMessages } = await import('../../../packages/merchant/src/phone-sign.ts')
    const words = askMessages(AGENT, facts)
    const stop = commandMessage(AGENT, 'stop', Date.now(), 'fedcba9876543210')
    served = [
      { seq: 1, message: words.approve, signature: await sigOf(stranger, words.approve) }, // another key
      { seq: 2, message: words.approve.replace('Amount: 1 CKB', 'Amount: 2 CKB'), signature: await sigOf(person, words.approve.replace('Amount: 1 CKB', 'Amount: 2 CKB')) }, // words nobody asked
      { seq: 3, message: commandMessage(AGENT, 'take-out', Date.now(), 'fedcba9876543211', 'ckt1qthief'), signature: await sigOf(person, commandMessage(AGENT, 'take-out', Date.now(), 'fedcba9876543211', 'ckt1qthief')) }, // elsewhere
      { seq: 4, message: commandMessage(AGENT, 'stop', Date.now() - 3600_000, 'fedcba9876543212'), signature: await sigOf(person, commandMessage(AGENT, 'stop', Date.now() - 3600_000, 'fedcba9876543212')) }, // too late
      { seq: 5, message: stop, signature: await sigOf(person, stop) },
    ]
    await s.phone.round()
    assert.equal(s.agent.approvals()[0]!.status, 'waiting', 'not approved by another key or other words')
    assert.equal(s.agent.status().take_out, null, 'no take-out elsewhere')
    assert.equal(s.agent.status().paused, true, 'the good stop, once')
    await s.agent.pause(false)
    served = [{ seq: 6, message: stop, signature: await sigOf(person, stop) }] // the same stop, played again
    await s.phone.round()
    assert.equal(s.agent.status().paused, false, 'a command played twice acts once')
    // After a restart too: the nonce is kept.
    const again = new Phone({ ...(s.phone as any).o })
    served = [{ seq: 7, message: stop, signature: await sigOf(person, stop) }]
    await again.round()
    assert.equal(s.agent.status().paused, false, 'not after a restart either')
    assert.equal(s.payer.pays.length, 0)
  } finally {
    await s.phone.stop()
    await s.close()
  }
})
