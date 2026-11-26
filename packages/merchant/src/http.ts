// The merchant over HTTP, for a shop written in any language. The shop's server calls it with its
// API key; nothing here is for browsers.
//
//   POST /v1/invoices        {amount_ckb, memo?, order_id?, metadata?, valid_minutes?}  -> 201 invoice
//   GET  /v1/invoices/<id>   by id (inv_...) or payment hash                           -> invoice
//   GET  /v1/invoices        ?status=open|paid|expired&order_id=&limit=                -> {data: [...]}
//   GET  /v1/balance                                                                    -> {ready, can_receive_ckb, balance_ckb}
//   GET  /v1/room            what more room costs, and the shop's rents                 -> {terms, rents}
//   POST /v1/room/rent       {room_ckb, months?}: rent room to receive from the LSP      -> 201 rent
//   POST /v1/room/place      bring paid room into a channel now                          -> 202 {}
//   GET  /health             no key                                                     -> {ok, ready}
//
// Errors: {error: {code, message}} with the status MerchantError gives.

import http from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { MerchantError } from './errors.ts'
import type { InvoiceStatus, Merchant } from './merchant.ts'

export type ServeOptions = { port: number; host?: string; apiKey: string; log?: (line: string) => void }

const STATUSES = new Set(['open', 'paid', 'expired'])
// Comparing digests keeps the comparison constant in time whatever the lengths.
const digest = (s: string) => createHash('sha256').update(s).digest()
const sameKey = (given: string, key: string) => timingSafeEqual(digest(given), digest(key))

export function merchantHandler(m: Merchant, o: Pick<ServeOptions, 'apiKey' | 'log'>): http.RequestListener {
  if (!o.apiKey || o.apiKey.length < 16) throw new Error('the API key must be at least 16 characters')
  return (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const fail = (e: unknown) => {
      if (e instanceof MerchantError) return send(e.status, { error: { code: e.code, message: e.message } })
      o.log?.(`merchant api: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      send(500, { error: { code: 'internal', message: 'something failed on the merchant side' } })
    }
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') return send(200, { ok: true, ready: m.status().ready })
    const auth = String(req.headers.authorization ?? '')
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!given || !sameKey(given, o.apiKey)) return send(401, { error: { code: 'unauthorized', message: 'a valid API key goes in Authorization: Bearer <key>' } })

    if (url.pathname === '/v1/balance' && req.method === 'GET') return send(200, m.status())
    if (url.pathname === '/v1/room' && req.method === 'GET') {
      m.roomTerms().then(
        (terms) => send(200, { terms, rents: m.rents() }),
        (e) => fail(e),
      )
      return
    }
    if (url.pathname === '/v1/room/place' && req.method === 'POST') {
      m.placeRoom().then(
        () => send(202, {}),
        (e) => fail(e),
      )
      return
    }
    if (url.pathname === '/v1/room/rent' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', async () => {
        let input
        try {
          input = JSON.parse(body || '{}')
        } catch {
          return send(400, { error: { code: 'invalid_request', message: 'the body must be JSON' } })
        }
        try {
          send(201, await m.rentRoom(input))
        } catch (e) {
          fail(e)
        }
      })
      return
    }
    if (url.pathname === '/v1/invoices' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 16_384) req.destroy()
      })
      req.on('end', async () => {
        let input
        try {
          input = JSON.parse(body || '{}')
        } catch {
          return send(400, { error: { code: 'invalid_request', message: 'the body must be JSON' } })
        }
        try {
          send(201, await m.createInvoice(input))
        } catch (e) {
          fail(e)
        }
      })
      return
    }
    if (url.pathname === '/v1/invoices' && req.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined
      if (status && !STATUSES.has(status)) return send(400, { error: { code: 'invalid_request', message: 'status is open, paid or expired' } })
      const limit = Number(url.searchParams.get('limit') ?? 20)
      return send(200, { data: m.list({ status: status as InvoiceStatus | undefined, order_id: url.searchParams.get('order_id') ?? undefined, limit: Number.isFinite(limit) ? limit : 20 }) })
    }
    const one = url.pathname.match(/^\/v1\/invoices\/([A-Za-z0-9_]{6,80})$/)
    if (one && req.method === 'GET') {
      const id = one[1] ?? ''
      const inv = m.get(id)
      return inv ? send(200, inv) : send(404, { error: { code: 'not_found', message: `no invoice ${id}` } })
    }
    send(404, { error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } })
  }
}

export function serveMerchant(m: Merchant, o: ServeOptions): Promise<http.Server> {
  const server = http.createServer(merchantHandler(m, o))
  return new Promise((resolve) => server.listen(o.port, o.host ?? '127.0.0.1', () => resolve(server)))
}
