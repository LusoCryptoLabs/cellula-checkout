// The agent's HTTP API, as cellula-mcp calls it: a key is required, it pays an invoice, pays a
// seller's 402 through /v1/fetch, and takes out only to the address set at start.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Agent } from '../src/agent.ts'
import { serveAgent } from '../src/agent-http.ts'
import { isPublicAddress } from '../src/public-fetch.ts'
import { Merchant } from '../src/merchant.ts'
import { paywall, Receipts } from '../src/x402.ts'
import { FakeNet, FakePayer, FakeShop } from './fake-payer.ts'

const dir = () => mkdtempSync(path.join(tmpdir(), 'agent-http-'))
const KEY = 'k'.repeat(32)

async function setup(o: { fetchPrivate?: boolean; allow?: string[]; approveAboveCkb?: string; approvalKey?: string; fetch?: typeof fetch } = {}) {
  const net = new FakeNet()
  const d = dir()
  const payer = new FakePayer(net)
  const swept: string[] = []
  const agent = await Agent.open({ session: payer, file: path.join(d, 'a.json'), caps: { per_payment_ckb: 1, total_ckb: 3 }, returnTo: 'ckt1qperson', sweep: async (to) => (swept.push(to), '0xswept'), closeWaitMs: 2_000, allow: o.allow, approveAboveCkb: o.approveAboveCkb, approvalsUrl: 'http://127.0.0.1:8280/approvals' })
  const api = await serveAgent(agent, { port: 0, apiKey: KEY, address: 'ckt1qagent', fetchPrivate: o.fetchPrivate, approvalKey: o.approvalKey, fetch: o.fetch })
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  const call = async (method: string, route: string, body?: unknown, key = KEY) => {
    const r = await fetch(base + route, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: (await r.json()) as Record<string, any> }
  }
  return { net, payer, agent, api, base, call, swept, close: () => new Promise((r) => api.close(r)) }
}

test('the API needs its key, and says the agent, its caps and where to top it up', async () => {
  const s = await setup()
  try {
    assert.equal((await s.call('GET', '/v1/status', undefined, 'wrong-key-wrong-key-wrong')).status, 401)
    assert.equal((await fetch(`${s.base}/health`)).status, 200, 'health needs no key')
    const st = await s.call('GET', '/v1/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.ready, true)
    assert.equal(st.body.address, 'ckt1qagent')
    assert.deepEqual(st.body.caps, { per_payment_ckb: '1', total_ckb: '3', left_ckb: '3', day_ckb: null, day_left_ckb: null })
  } finally {
    await s.close()
  }
})

test('POST /v1/pay pays an invoice and returns its receipt; past a cap it says why', async () => {
  const s = await setup()
  try {
    const b = s.net.bill(50_000_000n)
    const r = await s.call('POST', '/v1/pay', { invoice: b.invoice, memo: 'a report' })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'paid')
    assert.equal(r.body.preimage, b.preimage)
    const over = await s.call('POST', '/v1/pay', { invoice: s.net.bill(200_000_000n).invoice })
    assert.equal(over.status, 422)
    assert.equal(over.body.error.code, 'over_cap')
    assert.equal((await s.call('GET', '/v1/payments')).body.data.length, 1)
    assert.equal((await s.call('GET', `/v1/payments/${b.hash}`)).body.status, 'paid')
    assert.equal((await s.call('POST', '/v1/pay', { invoice: 42 })).status, 400)
  } finally {
    await s.close()
  }
})

// A seller on this machine, behind a paywall, counting what reaches it.
async function localSeller(s: Awaited<ReturnType<typeof setup>>) {
  const d = dir()
  const m = await Merchant.open({ session: new FakeShop(s.net), file: path.join(d, 'm.json') })
  const gate = paywall(m, { price_ckb: '0.25', payTo: '02' + 'ab'.repeat(32), receipts: new Receipts(path.join(d, 'used.json')) })
  const seen = { requests: 0, hosts: [] as string[] }
  const seller = http.createServer(async (req, res) => {
    seen.requests++
    seen.hosts.push(String(req.headers.host))
    if (!(await gate(req, res))) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, asked: req.method }))
  })
  await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r))
  return { seller, seen, port: (seller.address() as AddressInfo).port }
}

test('POST /v1/fetch pays a seller 402 and hands back the answer', async () => {
  // The seller is on this machine, so the person allowed that at start (AGENT_FETCH_PRIVATE=1).
  const s = await setup({ fetchPrivate: true })
  const { seller } = await localSeller(s)
  try {
    const url = `http://127.0.0.1:${(seller.address() as AddressInfo).port}/v1/report`
    const r = await s.call('POST', '/v1/fetch', { url, method: 'POST', body: '{}', max_ckb: '0.5' })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 200)
    assert.deepEqual(JSON.parse(r.body.body), { ok: true, asked: 'POST' })
    assert.equal(r.body.paid.amount_ckb, '0.25')
    assert.ok(r.body.headers['payment-response'])
    const tooDear = await s.call('POST', '/v1/fetch', { url, max_ckb: '0.1' })
    assert.equal(tooDear.status, 422)
    assert.equal(tooDear.body.error.code, 'over_cap')
    assert.equal((await s.call('POST', '/v1/fetch', { url: 'file:///etc/passwd' })).status, 400)
    assert.equal(s.agent.status().spent_ckb, '0.25')
  } finally {
    await new Promise((r) => seller.close(r))
    await s.close()
  }
})

test('POST /v1/fetch does not reach this machine or its network, and pays nothing there', async () => {
  const s = await setup()
  const { seller, seen, port } = await localSeller(s)
  try {
    for (const url of [
      `http://127.0.0.1:${port}/v1/report`, // an address in the URL
      `http://localhost:${port}/v1/report`, // a name looked up to one
      `http://[::1]:${port}/v1/report`,
      `http://[::ffff:127.0.0.1]:${port}/v1/report`,
      'http://169.254.169.254/latest/meta-data/', // a cloud machine's own keys
      'http://192.168.1.1/', // a router
      'http://10.0.0.1/',
    ]) {
      const r = await s.call('POST', '/v1/fetch', { url, max_ckb: '0.5' })
      assert.equal(r.status, 403, url)
      assert.equal(r.body.error.code, 'not_public', url)
    }
    assert.equal(seen.requests, 0, 'nothing reached the seller')
    assert.equal(s.agent.status().spent_ckb, '0')
  } finally {
    await new Promise((r) => seller.close(r))
    await s.close()
  }
})

test('the addresses the agent will not fetch', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.10', '224.0.0.1', '255.255.255.255', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1'])
    assert.equal(isPublicAddress(ip), false, ip)
  // IPv4-compatible, IPv4-translated, local-use
  // NAT64, 6to4 and Teredo carry an IPv4 address inside; site-local is still routed by some.
  for (const ip of ['::7f00:1', '::a00:1', '::ffff:0:7f00:1', '64:ff9b:1::7f00:1', '2002:7f00:1::1', '2002:c0a8:101::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fec0::1'])
    assert.equal(isPublicAddress(ip), false, ip)
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4003:80f::200e', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip)
  assert.equal(isPublicAddress('not an address'), false)
})

test('the API listens on this machine only', async () => {
  const agent = await Agent.open({ session: new FakePayer(new FakeNet()), file: path.join(dir(), 'a.json'), caps: { per_payment_ckb: 1, total_ckb: 3 }, returnTo: 'ckt1qperson' })
  for (const host of ['0.0.0.0', '::', '192.168.1.20']) {
    const api = await serveAgent(agent, { port: 0, host, apiKey: KEY }).catch((e: Error) => e)
    if (api instanceof http.Server) {
      await new Promise((r) => api.close(r))
      assert.fail(`it listened on ${host}`)
    }
    assert.match(api.message, /this machine only/, host)
  }
  const api = await serveAgent(agent, { port: 0, host: 'localhost', apiKey: KEY })
  await new Promise((r) => api.close(r))
})

test('POST /v1/fetch pays only a seller the person allows, by the host it fetched', async () => {
  for (const [allow, paid] of [
    [['other.example'], false],
    [['127.0.0.1'], true], // control: the seller's own host
  ] as const) {
    const s = await setup({ fetchPrivate: true, allow: [...allow] })
    const { seller, seen, port } = await localSeller(s)
    try {
      const r = await s.call('POST', '/v1/fetch', { url: `http://127.0.0.1:${port}/v1/report`, max_ckb: '0.5' })
      assert.equal(r.status, paid ? 200 : 403, allow.join())
      if (!paid) assert.equal(r.body.error.code, 'not_allowed')
      assert.equal(seen.requests, paid ? 2 : 1, 'refused: only the unpaid ask reached it')
      assert.equal(s.agent.status().spent_ckb, paid ? '0.25' : '0')
    } finally {
      await new Promise((r) => seller.close(r))
      await s.close()
    }
  }
})

test('POST /v1/pay takes no seller from its caller', async () => {
  const s = await setup({ allow: ['api.example.com'] })
  try {
    const r = await s.call('POST', '/v1/pay', { invoice: s.net.bill(10_000_000n).invoice, seller: 'api.example.com' })
    assert.equal(r.status, 403)
    assert.equal(r.body.error.code, 'not_allowed')
  } finally {
    await s.close()
  }
})

const APPROVAL_KEY = 'p'.repeat(40)

// A request with a Host header of our choosing (fetch does not let one be set).
function rawPost(base: string, route: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method: 'POST', headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0)))
    req.on('error', reject)
    req.end()
  })
}

test('the approvals page: only the person approves, from this machine, on the page itself', async () => {
  const s = await setup({ fetchPrivate: true, approveAboveCkb: '0.2', approvalKey: APPROVAL_KEY })
  const { seller, seen, port } = await localSeller(s) // asks 0.25
  const url = `http://127.0.0.1:${port}/v1/report`
  const page = (route: string, init: RequestInit = {}) => fetch(s.base + route, { redirect: 'manual', ...init })
  try {
    const asked = await s.call('POST', '/v1/fetch', { url, max_ckb: '0.5' })
    assert.equal(asked.status, 403)
    assert.equal(asked.body.error.code, 'needs_approval')
    assert.match(asked.body.error.message, /127\.0\.0\.1:8280\/approvals/)
    const id = s.agent.approvals()[0]!.id

    // The API's key opens nothing here.
    assert.equal((await page('/approvals', { headers: { authorization: `Bearer ${KEY}` } })).status, 401)
    assert.equal((await page(`/approvals/sign-in?key=${KEY}`)).status, 401)
    assert.equal((await page(`/approvals/${id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, origin: s.base } })).status, 401)

    const signIn = await page(`/approvals/sign-in?key=${APPROVAL_KEY}`)
    assert.equal(signIn.status, 303)
    const setCookie = signIn.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    const cookie = setCookie.split(';')[0]!
    const shown = await page('/approvals', { headers: { cookie } })
    assert.equal(shown.status, 200)
    assert.match(shown.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.equal(shown.headers.get('x-frame-options'), 'DENY')
    // Under no-referrer a browser posts the page's own forms with Origin: null, refused below.
    assert.equal(shown.headers.get('referrer-policy'), 'same-origin')
    const html = await shown.text()
    assert.match(html, /0\.25 CKB/)
    assert.match(html, new RegExp(`GET 127\\.0\\.0\\.1:${port}/v1/report`), 'what is bought')
    assert.match(html, new RegExp(`action="/approvals/${id}/approve"`))

    // A form from another page, none at all, or this page under another name: refused.
    assert.equal((await page(`/approvals/${id}/approve`, { method: 'POST', headers: { cookie, origin: 'http://evil.example' } })).status, 403)
    assert.equal((await page(`/approvals/${id}/approve`, { method: 'POST', headers: { cookie } })).status, 403)
    assert.equal(await rawPost(s.base, `/approvals/${id}/approve`, { cookie, origin: 'http://evil.example:8280', host: 'evil.example:8280' }), 403)
    assert.equal(s.agent.approvals()[0]!.status, 'waiting', 'still waiting')
    assert.equal(seen.requests, 1, 'only the unpaid ask reached the seller')

    const yes = await page(`/approvals/${id}/approve`, { method: 'POST', headers: { cookie, origin: s.base } })
    assert.equal(yes.status, 303)
    assert.equal(yes.headers.get('location'), '/approvals')
    const paid = await s.call('POST', '/v1/fetch', { url, max_ckb: '0.5' })
    assert.equal(paid.status, 200)
    assert.equal(paid.body.paid.amount_ckb, '0.25')
    assert.equal(s.agent.approvals()[0]!.status, 'used')
  } finally {
    await new Promise((r) => seller.close(r))
    await s.close()
  }
})

test('the approvals page shows what a caller wrote as text, and stops every payment', async () => {
  const s = await setup({ approveAboveCkb: '0.2', approvalKey: APPROVAL_KEY })
  try {
    const r = await s.call('POST', '/v1/pay', { invoice: s.net.bill(50_000_000n).invoice, memo: '<script>alert(1)</script><img src=x onerror=alert(2)>' })
    assert.equal(r.body.error.code, 'needs_approval')
    const signIn = await fetch(`${s.base}/approvals/sign-in?key=${APPROVAL_KEY}`, { redirect: 'manual' })
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0]!
    const html = await (await fetch(`${s.base}/approvals`, { headers: { cookie } })).text()
    assert.ok(!html.includes('<script>alert') && !html.includes('<img src=x'), 'no markup of the caller')
    assert.match(html, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/)

    const post = (route: string) => fetch(s.base + route, { method: 'POST', redirect: 'manual', headers: { cookie, origin: s.base } })
    assert.equal((await post('/approvals/pause')).status, 303)
    const stopped = await s.call('POST', '/v1/pay', { invoice: s.net.bill(10_000_000n).invoice })
    assert.equal(stopped.status, 423)
    assert.equal(stopped.body.error.code, 'paused')
    assert.match(await (await fetch(`${s.base}/approvals`, { headers: { cookie } })).text(), /Every payment is stopped/)
    assert.equal((await post('/approvals/resume')).status, 303)
    assert.equal((await s.call('POST', '/v1/pay', { invoice: s.net.bill(10_000_000n).invoice })).status, 200)
  } finally {
    await s.close()
  }
})

test('the approvals page lists waiting payments oldest first, so a new one never takes the place of one about to be tapped', async () => {
  const s = await setup({ approveAboveCkb: '0.2', approvalKey: APPROVAL_KEY })
  try {
    assert.equal((await s.call('POST', '/v1/pay', { invoice: s.net.bill(50_000_000n).invoice, memo: 'first' })).body.error.code, 'needs_approval')
    assert.equal((await s.call('POST', '/v1/pay', { invoice: s.net.bill(60_000_000n).invoice, memo: 'second' })).body.error.code, 'needs_approval')
    const signIn = await fetch(`${s.base}/approvals/sign-in?key=${APPROVAL_KEY}`, { redirect: 'manual' })
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0]!
    const html = await (await fetch(`${s.base}/approvals`, { headers: { cookie } })).text()
    assert.ok(html.indexOf('first') > 0 && html.indexOf('first') < html.indexOf('second'), 'the older card first')
  } finally {
    await s.close()
  }
})

test('the approvals page takes the balance out, to the address set at start, once the box is ticked', async () => {
  const s = await setup({ approvalKey: APPROVAL_KEY })
  try {
    const signIn = await fetch(`${s.base}/approvals/sign-in?key=${APPROVAL_KEY}`, { redirect: 'manual' })
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0]!
    const form = (body: string, headers: Record<string, string> = { cookie, origin: s.base }) =>
      fetch(`${s.base}/approvals/take-out`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body })
    const before = await (await fetch(`${s.base}/approvals`, { headers: { cookie } })).text()
    assert.match(before, /action="\/approvals\/take-out"/)
    assert.match(before, /name="sure" value="1" required/)
    assert.match(before, /ckt1qperson/, 'the address it goes to, in full')

    // Controls: the box not ticked, the API's key, another page, each takes nothing out.
    assert.equal((await form('')).status, 400)
    assert.equal((await form('sure=0')).status, 400)
    assert.equal((await form('sure=1', { authorization: `Bearer ${KEY}`, origin: s.base })).status, 401)
    assert.equal((await form('sure=1', { cookie, origin: 'http://evil.example' })).status, 403)
    // A form over 1 kB is answered 413, not cut off, and takes nothing out.
    const big = await form(`sure=1&pad=${'x'.repeat(4000)}`)
    assert.equal(big.status, 413)
    assert.match(await big.text(), /that form is too large/)
    assert.equal(s.agent.status().take_out, null, 'nothing taken out yet')

    const yes = await form('sure=1')
    assert.equal(yes.status, 303)
    assert.equal((await s.agent.takenOut())?.status, 'returned')
    assert.deepEqual(s.swept, ['ckt1qperson'])
    const after = await (await fetch(`${s.base}/approvals`, { headers: { cookie } })).text()
    assert.match(after, /Taken out: sent to <span class="addr">ckt1qperson<\/span>, transaction <span class="addr">0xswept<\/span>/)
    assert.ok(!after.includes('action="/approvals/take-out"'), 'no button once it is out')
    assert.equal((await s.call('GET', '/v1/status')).body.return_to, 'ckt1qperson', 'the status says where a take-out goes')
  } finally {
    await s.close()
  }
})

test('started without an approvals key, there is no page', async () => {
  const s = await setup()
  try {
    assert.equal((await fetch(`${s.base}/approvals`)).status, 404)
  } finally {
    await s.close()
  }
})

test('POST /v1/take-out sends the balance to the address set at start, whatever the body says', async () => {
  const s = await setup()
  try {
    const r = await s.call('POST', '/v1/take-out', { to: 'ckt1qthief' })
    assert.equal(r.status, 202)
    assert.equal(r.body.to, 'ckt1qperson')
    assert.equal((await s.agent.takenOut())?.status, 'returned')
    assert.deepEqual(s.swept, ['ckt1qperson'])
  } finally {
    await s.close()
  }
})

test('a seller that sends a byte at a time holds no fetch open past the longest', async () => {
  const { publicFetch } = await import('../src/public-fetch.ts')
  const seller = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    const t = setInterval(() => res.write('.'), 100)
    res.on('close', () => clearInterval(t))
  })
  await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r))
  try {
    const started = Date.now()
    const said = await publicFetch({ allowPrivate: true, longestMs: 800 })(`http://127.0.0.1:${(seller.address() as AddressInfo).port}/`)
      .then(async (r) => `answered ${(await r.text()).length}`)
      .catch((e) => `${e.code}: ${e.message}`)
    assert.match(said, /^timeout: .* took more than 0.8 s$/)
    assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`)
  } finally {
    seller.closeAllConnections()
    seller.close()
  }
})

test('POST /v1/fetch takes no Host header, nor any that changes where it goes: the URL is the seller', async () => {
  // A Host header would reach another site on the same machine or CDN, paid as the allowed seller.
  const s = await setup({ fetchPrivate: true, allow: ['127.0.0.1'] })
  const { seller, seen, port } = await localSeller(s)
  try {
    for (const h of ['Host', 'host', 'Transfer-Encoding', 'X-Forwarded-Host']) {
      const r = await s.call('POST', '/v1/fetch', { url: `http://127.0.0.1:${port}/v1/report`, headers: { [h]: 'evil.example' }, max_ckb: '0.5' })
      assert.equal(r.status, 400, h)
      assert.equal(r.body.error.code, 'invalid_request')
    }
    assert.equal(seen.requests, 0, 'nothing reached a seller')
    const plain = await s.call('POST', '/v1/fetch', { url: `http://127.0.0.1:${port}/v1/report`, headers: { accept: 'application/json' }, max_ckb: '0.5' })
    assert.equal(plain.status, 200, 'control: other headers go')
    assert.ok(seen.hosts.every((h) => h === `127.0.0.1:${port}`), seen.hosts.join())
  } finally {
    await new Promise((r) => seller.close(r))
    await s.close()
  }
})

test('a seller is paid over HTTPS only: over plain HTTP the receipt would cross the network in the clear', async () => {
  const { publicFetch } = await import('../src/public-fetch.ts')
  const local = publicFetch({ allowPrivate: true })
  let port = 0
  // seller.example, reached on this machine for the test.
  const via: typeof fetch = (input, init) => local(String(input instanceof Request ? input.url : input).replace(/^(https?):\/\/seller\.example/, `http://127.0.0.1:${port}`), init)
  const s = await setup({ fetch: via })
  const { seller, seen, port: p } = await localSeller(s)
  port = p
  try {
    const r = await s.call('POST', '/v1/fetch', { url: 'http://seller.example/v1/report', max_ckb: '0.5' })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'https_only')
    assert.equal(seen.requests, 1, 'the unpaid ask only')
    assert.equal(s.agent.status().spent_ckb, '0')
    const tls = await s.call('POST', '/v1/fetch', { url: 'https://seller.example/v1/report', max_ckb: '0.5' })
    assert.equal(tls.status, 200, 'control: the same seller over HTTPS is paid')
    assert.equal(s.agent.status().spent_ckb, '0.25')
  } finally {
    await new Promise((r) => seller.close(r))
    await s.close()
  }
})
