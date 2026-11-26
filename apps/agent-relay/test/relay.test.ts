// The relay as the agent and the person's page use it, with real signatures by CKB keys: it keeps an
// answer only when the wallet the agent named signed it, and the agent's writes need its secret.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ccc } from '@ckb-ccc/core'
import { relayHandler, type RelayState } from '../src/relay.ts'
import { askMessages, commandMessage, phoneToken } from '../../../packages/merchant/src/phone-sign.ts'

const client = new ccc.ClientPublicTestnet()
const person = new ccc.SignerCkbPrivateKey(client, '0x' + '11'.repeat(32))
const stranger = new ccc.SignerCkbPrivateKey(client, '0x' + '22'.repeat(32))
const AGENT = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqt5d97mu8h66t9h9y0ys02p8deqcczfm0gqtst4v'
const RETURN_TO = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2tu2x3nscv26nsmz5z6a6fe50sk8kapqge4yqyh'
const SECRET = 'cd'.repeat(32)
const TOKEN = phoneToken(SECRET)
const PAGE = 'https://testnet.cellula.id'

async function setup() {
  let clock = Date.parse('2026-11-01T17:30:05Z')
  const state: RelayState = { agents: {} }
  const server = http.createServer(relayHandler({ state, client, origins: [PAGE], addressPrefix: 'ckt', now: () => clock }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers }
  }
  const asAgent = { authorization: `Bearer ${SECRET}` }
  const approver = await person.getRecommendedAddress()
  return { state, base, call, asAgent, approver, tick: (ms: number) => (clock += ms), now: () => clock, close: () => new Promise((r) => server.close(r)) }
}
const sigOf = async (s: ccc.SignerCkbPrivateKey, m: string) => {
  const x = await s.signMessage(m)
  return { signature: x.signature, identity: x.identity, signType: x.signType }
}

test('the agent registers with its secret, and nobody else can write as it or change whose wallet answers', async () => {
  const r = await setup()
  try {
    assert.equal((await r.call('PUT', `/v1/agents/${TOKEN}`, { agent: AGENT, approver: r.approver, return_to: RETURN_TO, status: { balance_ckb: '20' } })).status, 401, 'no secret')
    assert.equal((await r.call('PUT', `/v1/agents/${TOKEN}`, { agent: AGENT, approver: r.approver, return_to: RETURN_TO, status: { balance_ckb: '20' } }, r.asAgent)).status, 200)
    assert.equal((await r.call('PUT', `/v1/agents/${TOKEN}`, { agent: AGENT, approver: r.approver, return_to: RETURN_TO, status: null }, { authorization: `Bearer ${'ef'.repeat(32)}` })).status, 401, 'another secret')
    const other = await stranger.getRecommendedAddress()
    assert.equal((await r.call('PUT', `/v1/agents/${TOKEN}`, { agent: AGENT, approver: other, return_to: RETURN_TO, status: null }, r.asAgent)).status, 409, 'another approver')
    const page = await r.call('GET', `/v1/agents/${TOKEN}`)
    assert.equal(page.status, 200)
    assert.deepEqual({ agent: page.body.agent, approver: page.body.approver, balance: page.body.status.balance_ckb }, { agent: AGENT, approver: r.approver, balance: '20' })
    assert.equal((await r.call('GET', '/v1/agents/nothex')).status, 400)
    assert.equal((await r.call('GET', `/v1/agents/${'00'.repeat(16)}`)).status, 404)
    assert.equal(r.state.agents[TOKEN]!.secret_hash.length, 64, 'the secret kept as its hash only')
    assert.ok(!JSON.stringify(r.state).includes(SECRET))
  } finally {
    await r.close()
  }
})

test("a waiting payment is kept only with this agent's own words, and an answer only when the approver's wallet signed it", async () => {
  const r = await setup()
  try {
    await r.call('PUT', `/v1/agents/${TOKEN}`, { agent: AGENT, approver: r.approver, return_to: RETURN_TO, status: null }, r.asAgent)
    const facts = { id: '3f2a9c01b2d4', amount_ckb: '1', seller: 'fiber-names-api.lusocryptolabs.com', payee: null, memo: 'POST /v1/bundle', expires_at: r.now() + 600_000 }
    const messages = askMessages(AGENT, facts)
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/asks`, { id: facts.id, messages, details: facts, expires_at: facts.expires_at })).status, 401, 'no secret')
    const otherAgent = askMessages('ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2tu2x3nscv26nsmz5z6a6fe50sk8kapqge4yqyh', facts)
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/asks`, { id: facts.id, messages: otherAgent, details: facts, expires_at: facts.expires_at }, r.asAgent)).status, 400, "another agent's words")
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/asks`, { id: facts.id, messages, details: facts, expires_at: r.now() + 3600_000 }, r.asAgent)).status, 400, 'open too long')
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/asks`, { id: facts.id, messages, details: facts, expires_at: facts.expires_at }, r.asAgent)).status, 200)
    const page = await r.call('GET', `/v1/agents/${TOKEN}`)
    assert.deepEqual(page.body.asks.map((a: any) => [a.id, a.answered]), [[facts.id, null]])

    // Answers: a stranger's signature, words nobody asked for, then the person's.
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: messages.approve, signature: await sigOf(stranger, messages.approve) })).status, 403)
    const made = messages.approve.replace('Amount: 1 CKB', 'Amount: 9 CKB')
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: made, signature: await sigOf(person, made) })).body.error.code, 'not_known')
    assert.equal((await r.call('GET', `/v1/agents/${TOKEN}/answers`, undefined, r.asAgent)).body.answers.length, 0, 'nothing kept so far')
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: messages.approve, signature: await sigOf(person, messages.approve) })).status, 200)
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: messages.approve, signature: await sigOf(person, messages.approve) })).status, 200, 'the same again: once')
    const got = await r.call('GET', `/v1/agents/${TOKEN}/answers?after=0`, undefined, r.asAgent)
    assert.deepEqual(got.body.answers.map((a: any) => [a.seq, a.kind, a.ask_id]), [[1, 'approve', facts.id]])
    assert.equal((await r.call('GET', `/v1/agents/${TOKEN}/answers?after=1`, undefined, r.asAgent)).body.answers.length, 0)
    assert.equal((await r.call('GET', `/v1/agents/${TOKEN}/answers`)).status, 401, 'the answers are read with the secret')
    assert.equal((await r.call('GET', `/v1/agents/${TOKEN}`)).body.asks[0].answered, 'approve')

    // A command, then one too old.
    const stop = commandMessage(AGENT, 'stop', r.now(), '0123456789abcdef')
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: stop, signature: await sigOf(person, stop) })).status, 200)
    const late = commandMessage(AGENT, 'resume', r.now() - 20 * 60_000, '0123456789abcdee', undefined, '00112233aabbccdd')
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: late, signature: await sigOf(person, late) })).body.error.code, 'not_known')
    const out = commandMessage(AGENT, 'take-out', r.now(), '0123456789abcded', 'ckt1qthief')
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: out, signature: await sigOf(person, out) })).body.error.code, 'not_known', 'a take-out elsewhere')
    assert.deepEqual((await r.call('GET', `/v1/agents/${TOKEN}/answers?after=1`, undefined, r.asAgent)).body.answers.map((a: any) => a.kind), ['command'])

    // Past its time, a waiting payment is gone.
    r.tick(600_000 + 1000)
    assert.equal((await r.call('GET', `/v1/agents/${TOKEN}`)).body.asks.length, 0)
  } finally {
    await r.close()
  }
})

test('a browser may read and answer from the page only, and a body or a client that is too much is turned away', async () => {
  const r = await setup()
  try {
    await r.call('PUT', `/v1/agents/${TOKEN}`, { agent: AGENT, approver: r.approver, return_to: RETURN_TO, status: null }, r.asAgent)
    assert.equal((await r.call('GET', `/v1/agents/${TOKEN}`, undefined, { origin: PAGE })).headers.get('access-control-allow-origin'), PAGE)
    assert.equal((await r.call('GET', `/v1/agents/${TOKEN}`, undefined, { origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null)
    const pre = await fetch(`${r.base}/v1/agents/${TOKEN}/answers`, { method: 'OPTIONS', headers: { origin: PAGE } })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), PAGE)
    assert.equal((await r.call('POST', `/v1/agents/${TOKEN}/answers`, { message: 'x'.repeat(30_000), signature: {} })).status, 413)
    let last = 0
    for (let i = 0; i < 245; i++) last = (await fetch(`${r.base}/health`, { headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': `198.51.100.${i % 250}` } })).status
    assert.equal(last, 429, 'one client, too many in a minute, whatever X-Forwarded-For it writes')
    assert.equal((await fetch(`${r.base}/health`, { headers: { 'x-real-ip': '203.0.113.10' } })).status, 200, 'control: another client')
  } finally {
    await r.close()
  }
})
