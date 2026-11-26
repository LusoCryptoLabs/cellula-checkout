// The agent over HTTP, for a program on the same machine (cellula-mcp, a script) that holds its API
// key. It listens on this machine only (127.0.0.1, ::1 or localhost); nothing here is for browsers.
// /v1/fetch reaches the public internet only (public-fetch.ts).
//
//   GET  /v1/status                                              -> {ready, balance_ckb, spent_ckb, caps, fee_due_ckb, take_out, address}
//   POST /v1/pay       {invoice, max_ckb?, memo?}                -> 200 paid | 202 sending | error
//   GET  /v1/payments  ?limit=                                   -> {data: [...]}
//   GET  /v1/payments/<payment hash>                             -> payment
//   POST /v1/fetch     {url, method?, headers?, body?, max_ckb?} -> {status, headers, body, paid}: pays a seller's 402 once
//   POST /v1/take-out                                            -> 202 take_out: to the person's address set at start
//   GET  /health       no key                                    -> {ok, ready}
//   /approvals         the person's page, with its own key, never the API's (agent-approvals.ts)
//
// Errors: {error: {code, message}} with the status MerchantError gives.

import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Agent } from './agent.ts'
import { approvalsRoute } from './agent-approvals.ts'
import { MerchantError } from './errors.ts'
import { publicFetch } from './public-fetch.ts'
import { fetchPaid } from './x402.ts'

export type AgentServeOptions = {
  port: number
  host?: string
  apiKey: string
  /** The agent's own address, to top it up (said in status). */
  address?: string
  log?: (line: string) => void
  /** Lets /v1/fetch reach this machine and its network too: for testing a seller here. */
  fetchPrivate?: boolean
  /** The key of the person's approvals page; absent: no page. */
  approvalKey?: string
  fetch?: typeof fetch
}

const digest = (s: string) => createHash('sha256').update(s).digest()
const sameKey = (given: string, key: string) => timingSafeEqual(digest(given), digest(key))
// A seller's answer handed back to the caller: enough for an API's JSON, not a download.
const BODY_MOST = 200_000
const PASSED_HEADERS = ['content-type', 'payment-response']
// Headers a caller may not set on a fetch: they would change where it goes or how it is framed. A
// Host header would reach another site on the same machine or CDN (TLS takes its name from it),
// paid as if it were the allowed seller the URL names.
const ROUTING_HEADERS = /^(host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|expect|forwarded|x-forwarded-.*)$/i

export function agentHandler(a: Agent, o: Omit<AgentServeOptions, 'port' | 'host'>): http.RequestListener {
  if (!o.apiKey || o.apiKey.length < 16) throw new Error('the API key must be at least 16 characters')
  const fetchFor = o.fetch ?? publicFetch({ allowPrivate: o.fetchPrivate })
  return (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const fail = (e: unknown) => {
      if (e instanceof MerchantError) return send(e.status, { error: { code: e.code, message: e.message } })
      o.log?.(`agent api: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      send(500, { error: { code: 'internal', message: 'something failed on the agent side' } })
    }
    const json = (most: number, then: (input: Record<string, unknown>) => Promise<void>) => {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > most) req.destroy()
      })
      req.on('end', async () => {
        let input
        try {
          input = JSON.parse(body || '{}')
        } catch {
          return send(400, { error: { code: 'invalid_request', message: 'the body must be JSON' } })
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: { code: 'invalid_request', message: 'the body must be a JSON object' } })
        try {
          await then(input)
        } catch (e) {
          fail(e)
        }
      })
    }
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') return send(200, { ok: true, ready: a.status().ready })
    if (approvalsRoute(a, o.approvalKey, req, res, url, o.log)) return
    const auth = String(req.headers.authorization ?? '')
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!given || !sameKey(given, o.apiKey)) return send(401, { error: { code: 'unauthorized', message: 'a valid API key goes in Authorization: Bearer <key>' } })

    if (url.pathname === '/v1/status' && req.method === 'GET') return send(200, { ...a.status(), address: o.address ?? null })
    if (url.pathname === '/v1/payments' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 20)
      return send(200, { data: a.payments({ limit: Number.isFinite(limit) ? limit : 20 }) })
    }
    const one = url.pathname.match(/^\/v1\/payments\/(0x[0-9a-fA-F]{64})$/)
    if (one && req.method === 'GET') {
      const p = a.get(one[1] ?? '')
      return p ? send(200, p) : send(404, { error: { code: 'not_found', message: `no payment ${one[1]}` } })
    }
    if (url.pathname === '/v1/pay' && req.method === 'POST') {
      return json(8_192, async (input) => {
        const p = await a.pay({ invoice: input.invoice as string, max_ckb: input.max_ckb as string | undefined, memo: input.memo as string | undefined })
        send(p.status === 'sending' ? 202 : 200, p)
      })
    }
    if (url.pathname === '/v1/fetch' && req.method === 'POST') {
      return json(BODY_MOST, async (input) => {
        const target = typeof input.url === 'string' ? input.url : ''
        let parsed: URL
        try {
          parsed = new URL(target)
        } catch {
          return send(400, { error: { code: 'invalid_request', message: 'url must be an http or https URL' } })
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return send(400, { error: { code: 'invalid_request', message: 'url must be an http or https URL' } })
        const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET'
        if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) return send(400, { error: { code: 'invalid_request', message: 'method is GET, POST, PUT, PATCH, DELETE or HEAD' } })
        const headers = new Headers()
        if (input.headers && typeof input.headers === 'object')
          for (const [k, v] of Object.entries(input.headers as Record<string, unknown>)) {
            if (typeof v !== 'string') continue
            if (ROUTING_HEADERS.test(k)) return send(400, { error: { code: 'invalid_request', message: `the ${k} header is not set by the caller: the URL says where the request goes` } })
            headers.set(k, v)
          }
        const body = typeof input.body === 'string' && method !== 'GET' && method !== 'HEAD' ? input.body : undefined
        const pay = async (invoice: string, maxCkb: string | null) => {
          // Over plain HTTP the receipt would cross the network in the clear, for anyone on the way
          // to take, and the host named would prove nothing: a seller is paid over HTTPS.
          if (parsed.protocol !== 'https:' && !o.fetchPrivate) throw new MerchantError('https_only', `${parsed.host} is asked over plain HTTP: a seller is paid over HTTPS only`, 400)
          // The seller is the host fetched here: the allowed sellers and an approval match it. The
          // memo says what was bought, for the person's page and the payments.
          const p = await a.pay({ invoice, max_ckb: maxCkb ?? undefined, memo: `${method} ${parsed.host}${parsed.pathname}`, seller: parsed.hostname })
          return { payment_hash: p.payment_hash, amount_ckb: p.amount_ckb, preimage: p.preimage, status: p.status }
        }
        const r = await fetchPaid(parsed.href, { method, headers, body, redirect: 'manual' }, pay, { max_ckb: (input.max_ckb as string | undefined) ?? null, fetch: fetchFor })
        const text = await r.response.text()
        const passed: Record<string, string> = {}
        for (const h of PASSED_HEADERS) {
          const v = r.response.headers.get(h)
          if (v) passed[h] = v
        }
        send(200, { status: r.response.status, headers: passed, body: text.length > BODY_MOST ? text.slice(0, BODY_MOST) : text, truncated: text.length > BODY_MOST, paid: r.paid })
      })
    }
    if (url.pathname === '/v1/take-out' && req.method === 'POST') {
      a.takeOut().then(
        (t) => send(202, t),
        (e) => fail(e),
      )
      return
    }
    send(404, { error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } })
  }
}

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost']

export async function serveAgent(a: Agent, o: AgentServeOptions): Promise<http.Server> {
  const host = o.host ?? '127.0.0.1'
  // The key goes with every call in plain HTTP: on a network anyone on it could read it.
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error(`the agent's API listens on this machine only (${LOOPBACK_HOSTS.join(', ')}), not ${host}`)
  const server = http.createServer(agentHandler(a, o))
  return new Promise((resolve) => server.listen(o.port, host, () => resolve(server)))
}
