// The phone path under stress: a relay that forgets or floods, one who has the link taking a token
// first, a late go-again, one network filling the relay, and a post-quantum wallet's answer. The
// agent, the relay and the person's signatures are real; only the payment network is faked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { ccc } from '@ckb-ccc/core'
import { PqSigner, PQ_SEED_BYTES, pqKeyFromSeed } from 'cellula-sdk'
import { placeOf, relayHandler, type RelayState } from '../src/relay.ts'
import { Agent } from '../../../packages/merchant/src/agent.ts'
import { Phone } from '../../../packages/merchant/src/agent-phone.ts'
import { agentMark, askMessages, commandMessage, phoneToken } from '../../../packages/merchant/src/phone-sign.ts'
import { FakeNet, FakePayer } from '../../../packages/merchant/test/fake-payer.ts'

const client = new ccc.ClientPublicTestnet()
const person = new ccc.SignerCkbPrivateKey(client, '0x' + '11'.repeat(32))
const AGENT = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqt5d97mu8h66t9h9y0ys02p8deqcczfm0gqtst4v'
const RETURN_TO = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2tu2x3nscv26nsmz5z6a6fe50sk8kapqge4yqyh'
const SECRET = 'cd'.repeat(32)
const TOKEN = phoneToken(SECRET)
const ckb = (n: number) => BigInt(Math.round(n * 1e8))
const sigOf = async (s: ccc.Signer, m: string) => {
  const x = await s.signMessage(m)
  return { signature: x.signature, identity: x.identity, signType: x.signType }
}
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e: any) {
    return e.message as string
  }
}
const nonce = (i: number) => i.toString(16).padStart(16, '0')

async function relayAt(now?: () => number) {
  const state: RelayState = { agents: {} }
  const server = http.createServer(relayHandler({ state, client, origins: [], addressPrefix: 'ckt', now }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, state, close: () => new Promise((r) => server.close(r)) }
}

async function agentWith(relay: string, o: { fetch?: typeof fetch; approver?: string; logs?: string[] } = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'phone-guards-'))
  const file = path.join(d, 'phone.json')
  writeFileSync(file, JSON.stringify({ token: TOKEN, secret: SECRET }))
  const net = new FakeNet()
  const payer = new FakePayer(net)
  const agent = await Agent.open({ session: payer, file: path.join(d, 'a.json'), caps: { per_payment_ckb: 2, total_ckb: 10 }, approveAboveCkb: '0.5', returnTo: RETURN_TO, sweep: async () => '0xswept', closeWaitMs: 2_000, waitMs: 2_000, phone: true })
  const approver = o.approver ?? (await person.getRecommendedAddress())
  const phone = new Phone({ agent, relay, page: 'https://testnet.cellula.id/agent', token: TOKEN, secret: SECRET, address: AGENT, approver, returnTo: RETURN_TO, client, file, fetch: o.fetch, statusMs: 0, log: (l) => o.logs?.push(l) })
  return { net, payer, agent, phone, file }
}

const answer = async (relay: string, message: string, signer: ccc.Signer = person) =>
  (await fetch(`${relay}/v1/agents/${TOKEN}/answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature: await sigOf(signer, message) }) })).status

test('a relay that forgets the token (a week off, a lost file): the next stop still acts, and what waits is posted again', async () => {
  const relay = await relayAt()
  const s = await agentWith(relay.url)
  try {
    await s.phone.round()
    for (let i = 0; i < 4; i++) {
      assert.equal(await answer(relay.url, commandMessage(AGENT, i % 2 ? 'resume' : 'stop', Date.now(), nonce(0xa0 + i), undefined, s.agent.status().paused_id ?? undefined)), 200)
      await s.phone.round()
    }
    assert.equal(s.agent.status().paused, false)
    await code(s.agent.pay({ invoice: s.net.bill(ckb(1)).invoice }))
    await s.phone.round()
    assert.equal(relay.state.agents[TOKEN]!.asks.length, 1)

    delete relay.state.agents[TOKEN] // what the relay does after 7 days without the agent, or with its file lost
    await s.phone.round()
    assert.equal(relay.state.agents[TOKEN]?.asks.length, 1, 'the waiting payment is on the page again')
    assert.equal(await answer(relay.url, commandMessage(AGENT, 'stop', Date.now(), nonce(0xff01))), 200)
    await s.phone.round()
    assert.equal(s.agent.status().paused, true, 'the stop after it acted')
  } finally {
    await relay.close()
  }
})

test("one who has the link cannot take a token the relay does not hold, and the agent's caller is not given the link", async () => {
  const relay = await relayAt()
  const s = await agentWith(relay.url)
  try {
    const squat = await fetch(`${relay.url}/v1/agents/${TOKEN}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${'ee'.repeat(32)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: AGENT, approver: await person.getRecommendedAddress(), return_to: RETURN_TO, status: { paused: true } }),
    })
    assert.equal(squat.status, 403)
    await s.phone.round()
    assert.equal(relay.state.agents[TOKEN]?.status?.paused, false, "the page reads the agent's own status")
    const said = await code(s.agent.pay({ invoice: s.net.bill(ckb(1)).invoice }))
    assert.match(said, /with their wallet on their phone/)
    assert.ok(!said.includes(TOKEN) && !said.includes('#phone='), 'no link in what the caller reads')
  } finally {
    await relay.close()
  }
})

test('a relay that floods the agent: a reply too large is refused at once, and a wild count changes nothing after', async () => {
  const relay = await relayAt()
  let flood: string | null = null
  const fetchVia: typeof fetch = async (input, init) => (flood !== null && String(input).includes('/answers') ? new Response(flood, { status: 200 }) : fetch(input, init))
  const logs: string[] = []
  const s = await agentWith(relay.url, { fetch: fetchVia, logs })
  try {
    await s.phone.round()
    const junk = Array.from({ length: 20_000 }, (_, i) => ({ seq: i + 1, message: `junk ${i}`, signature: { signature: '0x', identity: '0x', signType: 'x' } }))
    flood = JSON.stringify({ answers: junk })
    let t = performance.now()
    await s.phone.round()
    const tooLarge = performance.now() - t
    assert.ok(tooLarge < 2_000, `a ${flood.length} byte reply took ${Math.round(tooLarge)} ms`)
    assert.match(logs.join('\n'), /over 262144 bytes/)

    flood = JSON.stringify({ answers: junk.slice(0, 4_000) }) // under the size, many answers
    t = performance.now()
    await s.phone.round()
    assert.ok(performance.now() - t < 2_000, `4,000 junk answers took ${Math.round(performance.now() - t)} ms`)

    const stop = commandMessage(AGENT, 'stop', Date.now(), nonce(0xbad))
    flood = JSON.stringify({ answers: [{ seq: 9e15, message: 'junk', signature: await sigOf(person, 'junk') }] })
    await s.phone.round()
    flood = null // the relay honest again
    assert.equal(await answer(relay.url, stop), 200)
    await s.phone.round()
    assert.equal(s.agent.status().paused, true, 'the next stop acted')
  } finally {
    await relay.close()
  }
})

test('a go-again held back past a later stop changes nothing, whatever the clocks say', async () => {
  const relay = await relayAt()
  const s = await agentWith(relay.url)
  try {
    await s.phone.round()
    await s.agent.pause(true)
    // Signed on the phone for that stop, its clock 30 s ahead, and held back by the relay...
    const held = commandMessage(AGENT, 'resume', Date.now() + 30_000, nonce(0xc1), undefined, s.agent.status().paused_id!)
    await s.agent.pause(true) // ...while the person stops again on the computer.
    assert.equal(await answer(relay.url, held), 200)
    await s.phone.round()
    assert.equal(s.agent.status().paused, true, 'the go-again for the earlier stop was not taken')
    assert.equal(await answer(relay.url, commandMessage(AGENT, 'resume', Date.now() - 30_000, nonce(0xc2), undefined, s.agent.status().paused_id!)), 200)
    await s.phone.round()
    assert.equal(s.agent.status().paused, false, 'control: one for the stop in force is, its clock 30 s behind')
  } finally {
    await relay.close()
  }
})

test('a stop from the phone always stops, its clock behind or not', async () => {
  const relay = await relayAt()
  const s = await agentWith(relay.url)
  try {
    await s.phone.round()
    await s.agent.pause(true)
    await s.agent.pause(false) // stopped and let go on the computer just now
    assert.equal(await answer(relay.url, commandMessage(AGENT, 'stop', Date.now() - 60_000, nonce(0xd1))), 200)
    await s.phone.round()
    assert.equal(s.agent.status().paused, true)
  } finally {
    await relay.close()
  }
})

test("an answer whose signature could not be checked (the chain not read) is checked again, not lost", async () => {
  const relay = await relayAt()
  const s = await agentWith(relay.url)
  try {
    await s.phone.round()
    assert.equal(await answer(relay.url, commandMessage(AGENT, 'stop', Date.now(), nonce(0xe1))), 200)
    // The agent's chain reads fail for a round.
    const client = (s.phone as any).o.client
    const real = client.getKnownScript.bind(client)
    let down = true
    client.getKnownScript = async (...a: unknown[]) => {
      if (down) throw new Error('fetch failed')
      return real(...a)
    }
    await s.phone.round()
    assert.equal(s.agent.status().paused, false, 'not acted on while it cannot be checked')
    down = false
    await s.phone.round()
    assert.equal(s.agent.status().paused, true, 'acted on once it can')
  } finally {
    await relay.close()
  }
})

test('the link carries the agent it is for', () => {
  const phone = new Phone({ agent: {} as never, relay: 'https://r.example', page: 'https://testnet.cellula.id/agent', token: TOKEN, secret: SECRET, address: AGENT, approver: AGENT, returnTo: null, client, file: 'unused.json' })
  assert.equal(phone.url(), `https://testnet.cellula.id/agent#phone=${TOKEN}.${agentMark(AGENT)}`)
  assert.match(agentMark(AGENT), /^[0-9a-f]{12}$/)
  assert.notEqual(agentMark(AGENT), agentMark(RETURN_TO))
})

test("a post-quantum wallet's answer fits, and approves", async () => {
  const relay = await relayAt()
  const pq = new PqSigner(client, pqKeyFromSeed(new Uint8Array(PQ_SEED_BYTES).fill(7)))
  const s = await agentWith(relay.url, { approver: await pq.getRecommendedAddress() })
  try {
    await code(s.agent.pay({ invoice: s.net.bill(ckb(1)).invoice }))
    await s.phone.round()
    const words = askMessages(AGENT, s.agent.approvals()[0]!)
    assert.equal(await answer(relay.url, words.approve, pq), 200)
    await s.phone.round()
    assert.equal(s.agent.approvals()[0]!.status, 'approved')
  } finally {
    await relay.close()
  }
})

test('the relay: asks that end soon do not pile up, answers are kept to a few, and one network cannot take every place', async () => {
  let clock = Date.parse('2026-11-01T19:00:00Z')
  const relay = await relayAt(() => clock)
  const put = (secret: string, ip: string) =>
    fetch(`${relay.url}/v1/agents/${phoneToken(secret)}`, { method: 'PUT', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify({ agent: AGENT, approver: RETURN_TO, return_to: RETURN_TO, status: null }) })
  try {
    assert.equal((await put(SECRET, '203.0.113.1')).status, 200)
    const ask = (i: number) => {
      const facts = { id: i.toString(16).padStart(12, '0'), amount_ckb: '1', seller: 'a.example', payee: null, memo: '', expires_at: clock + 1000 }
      return fetch(`${relay.url}/v1/agents/${TOKEN}/asks`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: facts.id, messages: askMessages(AGENT, facts), details: {}, expires_at: facts.expires_at }) })
    }
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) assert.equal((await ask(round * 100 + i)).status, 200)
      assert.equal((await ask(round * 100 + 99)).status, 429, 'the 21st open ask')
      clock += 2000
    }
    await fetch(`${relay.url}/health`)
    assert.ok(relay.state.agents[TOKEN]!.asks.length <= 20, `${relay.state.agents[TOKEN]!.asks.length} asks held`)

    // Answers: a few kept, the newest.
    const approver = await person.getRecommendedAddress()
    const SECRET2 = 'ab'.repeat(32)
    const T2 = phoneToken(SECRET2)
    await fetch(`${relay.url}/v1/agents/${T2}`, { method: 'PUT', headers: { authorization: `Bearer ${SECRET2}`, 'content-type': 'application/json', 'x-real-ip': '203.0.113.2' }, body: JSON.stringify({ agent: AGENT, approver, return_to: RETURN_TO, status: null }) })
    for (let i = 0; i < 25; i++) {
      const m = commandMessage(AGENT, 'stop', clock, nonce(0xd00 + i))
      assert.equal((await fetch(`${relay.url}/v1/agents/${T2}/answers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.3' }, body: JSON.stringify({ message: m, signature: await sigOf(person, m) }) })).status, 200)
    }
    assert.equal(relay.state.agents[T2]!.answers.length, 20)
    assert.ok(relay.state.agents[T2]!.answers.at(-1)!.message.includes(nonce(0xd00 + 24)))

    // Ten agents from one IPv6 /48, each from its own /64; the eleventh is turned away, another site is not.
    for (let i = 0; i < 10; i++) assert.equal((await put(i.toString(16).padStart(64, 'e'), `2001:db8:1:${i + 1}::7`)).status, 200)
    assert.equal((await put('f'.repeat(64), '2001:db8:1:ff::7')).status, 429)
    assert.equal((await put('9'.repeat(64), '2001:db8:2::7')).status, 200, 'control: another site')
  } finally {
    await relay.close()
  }
})

test('the relay, full, gives the place of an agent not heard from in an hour, and of no other', async () => {
  let clock = Date.parse('2026-11-01T19:00:00Z')
  const relay = await relayAt(() => clock)
  const put = (i: number) => {
    const secret = i.toString(16).padStart(64, '0')
    return fetch(`${relay.url}/v1/agents/${phoneToken(secret)}`, { method: 'PUT', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-real-ip': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${Math.floor(i / 10) & 255}` }, body: JSON.stringify({ agent: AGENT, approver: RETURN_TO, return_to: RETURN_TO, status: null }) })
  }
  try {
    for (let i = 0; i < 2000; i++) {
      const r = await put(i)
      if (r.status !== 200) assert.fail(`agent ${i}: ${r.status}`)
      clock += 1
    }
    assert.equal((await put(5000)).status, 503, 'full, everyone heard from lately')
    clock += 3600_000
    for (let i = 1; i < 2000; i++) relay.state.agents[phoneToken(i.toString(16).padStart(64, '0'))]!.updated_at = clock
    assert.equal((await put(5001)).status, 200, 'the one idle for an hour gave its place')
    assert.equal(relay.state.agents[phoneToken((0).toString(16).padStart(64, '0'))], undefined)
  } finally {
    await relay.close()
  }
})

test('where a request comes from: an IPv4 address, an IPv6 network', () => {
  assert.equal(placeOf('203.0.113.9', 4), '203.0.113.9')
  assert.equal(placeOf('::ffff:203.0.113.9', 4), '203.0.113.9')
  assert.equal(placeOf('2001:db8:1:2::5', 4), '2001:db8:1:2::/64')
  assert.equal(placeOf('2001:0db8:0001:0002:0:0:0:5', 4), '2001:db8:1:2::/64')
  assert.equal(placeOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 3), '2001:db8:1::/48')
  assert.equal(placeOf('2001:db8::1', 4), '2001:db8:0:0::/64')
})
