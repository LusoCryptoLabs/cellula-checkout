// A demo shop paid over Fiber, on testnet: the merchant kit on the server, the Pay with Fiber button
// in the page. An order gets an invoice from the shop's own channel; the page opens the person's
// checkout; the shop marks the order paid when its signed webhook says so (or, failing that, when
// the shop asks its own merchant). Never from the page's word.
//
//   SHOP_DIR=/var/lib/fiber-shop  SHOP_KEY_FILE=/etc/fiber-shop.key  PORT=8263  node shop.mjs

import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMerchant, startOwnNodeMerchant } from '../../../packages/merchant/src/start.ts'
import { verifyWebhook } from '../../../packages/merchant/src/webhook.ts'
import { MerchantError } from '../../../packages/merchant/src/errors.ts'
import type { Merchant } from '../../../packages/merchant/src/merchant.ts'
import { JsonFile } from '../../../packages/merchant/src/store.ts'
import { shopStatus } from './status.ts'

const DIR = process.env.SHOP_DIR ?? path.resolve('shop-data')
const KEY_FILE = process.env.SHOP_KEY_FILE ?? path.join(DIR, 'shop.key')
const PORT = Number(process.env.PORT ?? 8263)
const HOST = process.env.HOST ?? '127.0.0.1'
const PAY_SCRIPT = process.env.PAY_SCRIPT ?? 'https://testnet.cellula.id/pay-with-fiber.js'
const PUBLIC = process.env.SHOP_PUBLIC ?? fileURLToPath(new URL('./public/', import.meta.url))
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

const PRODUCTS = [
  { id: 'espresso', name: 'Espresso', price_ckb: '2', blurb: 'A small coffee, paid in seconds.' },
  { id: 'stickers', name: 'Sticker pack', price_ckb: '5', blurb: 'Six stickers of the Fiber lab.' },
  { id: 'notes', name: 'Field notes', price_ckb: '9', blurb: 'A short guide to payment channels, as an ebook.' },
]

mkdirSync(DIR, { recursive: true })

type Order = { id: string; product: string; amount_ckb: string; invoice_id: string; status: 'pending' | 'paid'; paid_by: 'webhook' | 'check' | null; created_at: number; paid_at: number | null }
const orders = new JsonFile<{ orders: Order[] }>(path.join(DIR, 'orders.json'), () => ({ orders: [] }))
// The webhook's secret, made once and kept beside the orders.
const secretFile = path.join(DIR, 'webhook.secret')
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 })
const SECRET = readFileSync(secretFile, 'utf8').trim()

let merchant: Merchant | null = null
let startError = ''

function markPaid(orderId: string | null | undefined, by: 'webhook' | 'check') {
  const o = orders.value.orders.find((x) => x.id === orderId)
  if (!o || o.status === 'paid') return
  o.status = 'paid'
  o.paid_by = by
  o.paid_at = Date.now()
  void orders.save()
  log(`order ${o.id} paid (${o.amount_ckb} CKB, ${o.product}), learnt by ${by}`)
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const CSP = `default-src 'self'; script-src 'self' ${new URL(PAY_SCRIPT).origin}; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const read = (max: number, done: (body: string) => void) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > max) req.destroy()
    })
    req.on('end', () => done(body))
  }

  if (url.pathname === '/health') return json(200, { ok: true, ready: !!merchant?.status().ready })
  if (url.pathname === '/api/status') return json(200, shopStatus(merchant, startError))
  if (url.pathname === '/api/products') return json(200, { products: PRODUCTS, pay_script: PAY_SCRIPT })

  // The shop's server learns of payments here, signed by its merchant.
  if (url.pathname === '/hooks/fiber' && req.method === 'POST') {
    return read(65_536, (body) => {
      if (!verifyWebhook(body, req.headers['fiber-signature'] as string | undefined, SECRET)) {
        log('a webhook with a bad signature was refused')
        return json(400, { error: 'bad signature' })
      }
      const e = JSON.parse(body)
      if (e.type === 'invoice.paid') markPaid(e.data?.invoice?.order_id, 'webhook')
      json(200, { received: true })
    })
  }

  if (url.pathname === '/api/orders' && req.method === 'POST') {
    return read(2048, async (body) => {
      let product: string | undefined
      try {
        product = JSON.parse(body || '{}').product
      } catch {
        return json(400, { error: 'the body must be JSON' })
      }
      const p = PRODUCTS.find((x) => x.id === product)
      if (!p) return json(404, { error: 'no such product' })
      if (!merchant) return json(503, { error: 'the shop is still opening its channel; try again in a minute' })
      const order: Order = { id: `o_${randomBytes(6).toString('hex')}`, product: p.id, amount_ckb: p.price_ckb, invoice_id: '', status: 'pending', paid_by: null, created_at: Date.now(), paid_at: null }
      try {
        const inv = await merchant.createInvoice({ amount_ckb: p.price_ckb, order_id: order.id, memo: `${p.name}, Fiber demo shop`, metadata: { product: p.id }, valid_minutes: 15 })
        order.invoice_id = inv.id
        orders.value.orders.push(order)
        await orders.save()
        json(201, { order, invoice: inv.invoice, payment_hash: inv.payment_hash, expires_at: inv.expires_at })
      } catch (e) {
        if (e instanceof MerchantError) return json(e.status, { error: e.message })
        log(`order failed: ${e instanceof Error ? e.message : String(e)}`)
        json(500, { error: 'the shop could not make an invoice' })
      }
    })
  }

  const one = url.pathname.match(/^\/api\/orders\/(o_[0-9a-f]{12})$/)
  if (one && req.method === 'GET') {
    const o = orders.value.orders.find((x) => x.id === one[1])
    if (!o) return json(404, { error: 'no such order' })
    // Should a webhook be late, the shop asks its own merchant: still the shop's own signer.
    if (o.status === 'pending' && merchant?.get(o.invoice_id)?.status === 'paid') markPaid(o.id, 'check')
    const inv = merchant?.get(o.invoice_id)
    return json(200, { ...o, invoice_status: inv?.status ?? null })
  }

  // The page and its files.
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const f = path.join(PUBLIC, file)
  if (!/^[a-z0-9._-]+$/.test(file) || !f.startsWith(path.resolve(PUBLIC)) || !existsSync(f)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found')
  }
  let content: string | Buffer = readFileSync(f)
  if (file === 'index.html') content = content.toString('utf8').replace('__PAY_SCRIPT__', PAY_SCRIPT)
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' })
  res.end(content)
})

await new Promise<void>((r) => server.listen(PORT, HOST, () => r()))
log(`shop on http://${HOST}:${PORT}`)

// The channel opens after the page is up, so the page can say the shop is getting ready.
try {
  const webhook = { url: `http://127.0.0.1:${PORT}/hooks/fiber`, secret: SECRET }
  // FIBER_NODE_RPC: the shop's own Fiber node takes the payments (docs/OWN-NODE.md), its token, when
  // its RPC asks for one, in FIBER_NODE_TOKEN_FILE. Otherwise a hosted session on LSP3.
  if (process.env.FIBER_NODE_RPC) {
    const tokenFile = process.env.FIBER_NODE_TOKEN_FILE
    const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined
    merchant = (await startOwnNodeMerchant({ dir: path.join(DIR, 'own-node'), node: { url: process.env.FIBER_NODE_RPC, token }, webhook, log })).merchant
  } else {
    if (!existsSync(KEY_FILE)) throw new Error(`no key at ${KEY_FILE}: put the shop's testnet key there (hex) and fund its address`)
    const started = await startMerchant({ dir: path.join(DIR, 'fiber'), key: readFileSync(KEY_FILE, 'utf8').trim(), openCkb: 10, webhook, log })
    merchant = started.merchant
  }
} catch (e) {
  startError = e instanceof Error ? e.message : String(e)
  log(`the merchant did not start: ${startError}`)
}
