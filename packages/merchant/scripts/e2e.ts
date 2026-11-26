// The merchant end to end on testnet, through LSP3: a shop (this package, with its HTTP API and a
// webhook to a receiver standing in for the shop's server) and a payer (a plain FiberSession, as
// the nightly runs one), each with its own channel funded from its own testnet key. Checked:
// an invoice made over HTTP and one made by the library are paid, the shop's server gets each
// invoice.paid signed, an unpaid one expires and says so, and both channels close at the end.
//
//   node scripts/build.mjs e2e && E2E_KEYS=<file of two keys> node dist-e2e/e2e.mjs
// Each key needs about 700 test CKB the first time: the LSP's opening fee of 500 is once per wallet, paid
// by the merchant once the shop's channel is ready and by the payer's session before its first payment.
// Exit 0 when every check passed.

import http from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { ccc } from '@ckb-ccc/core'
import { FiberSession } from '../../../vendor/fiber-session/index.ts'
import { nodeHost } from '../../../vendor/fiber-session/node.ts'
import { startMerchant, lsp3Testnet } from '../src/start.ts'
import { serveMerchant } from '../src/http.ts'
import { verifyWebhook } from '../src/webhook.ts'

const KEYS = process.env.E2E_KEYS ?? ''
const DIR = process.env.E2E_DIR ?? path.join(process.cwd(), 'e2e-runs')
const MINUTE = 60_000
const t0 = Date.now()
const say = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a)
let bad = 0
const ok = (v: boolean, what: string, d = '') => {
  if (!v) bad++
  say(`${v ? 'ok  ' : 'FAIL'} ${what}${d ? ': ' + d : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean | Promise<boolean>, ms: number, every = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if (await what()) return true
  return what()
}
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer in ${ms / 1000} s`)))])
}

const [kShop, kPayer] = readFileSync(KEYS, 'utf8').split(/\s+/).filter(Boolean)
if (!kShop || !kPayer) throw new Error('E2E_KEYS must name a file of two testnet keys: the shop, then the payer')
const run = path.join(DIR, new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(run, { recursive: true })
say('run in', run)

// The shop's server, as far as webhooks go: it checks each signature before believing a word.
const secret = randomBytes(24).toString('hex')
const hooks: { type: string; id: string; valid: boolean }[] = []
const receiver = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const valid = verifyWebhook(body, req.headers['fiber-signature'] as string, secret)
    const e = JSON.parse(body)
    hooks.push({ type: e.type, id: e.data?.invoice?.id, valid })
    res.writeHead(valid ? 200 : 400).end()
  })
})
await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()))
const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`

const client = new ccc.ClientPublicTestnet()
const payerWallet = new ccc.SignerCkbPrivateKey(client, kPayer.startsWith('0x') ? kPayer : `0x${kPayer}`)
let shop: Awaited<ReturnType<typeof startMerchant>> | null = null
let payer: FiberSession | null = null
let api: http.Server | null = null
try {
  // One session after the other: both load the one signer module (see the nightly).
  shop = await within(startMerchant({ dir: path.join(run, 'shop'), key: kShop, openCkb: 10, webhook: { url: hookUrl, secret }, log: (l) => say('shop:', l) }), 12 * MINUTE, 'the shop ready')
  const { merchant } = shop
  ok(merchant.status().ready, 'the shop has a channel ready', JSON.stringify(merchant.status()))
  ok(shop.session.state.feeDue === 0n, "the shop's opening fee is paid, or none was due")

  payer = new FiberSession(nodeHost({ file: path.join(run, 'payer3.json'), restart: () => say('payer: the session asked to start again') }), {
    ...lsp3Testnet(),
    ownerKey: (h) => `merchant-e2e-payer:${h}`,
    lockName: 'merchant-e2e:payer',
  })
  await payer.start()
  await within(payer.open(payerWallet, 20n), 5 * MINUTE, 'payer opening')
  await within(payer.whenReady(), 10 * MINUTE, 'payer channel ready')
  say('payer ready with', ccc.fixedPointToString(payer.state.channel?.local ?? 0n), 'CKB')

  // 1. Over HTTP, as a shop in any language would.
  const apiKey = randomBytes(24).toString('hex')
  api = await serveMerchant(merchant, { port: 0, apiKey })
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  const made = await (await fetch(`${base}/v1/invoices`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount_ckb: '0.5', order_id: 'e2e-1', memo: 'Coffee' }) })).json()
  ok(made.status === 'open' && /^fibt\d/.test(made.invoice), 'the API made an invoice', `${made.id} ${String(made.invoice).slice(0, 20)}...`)
  const before = merchant.status().balance_ckb
  const t1 = Date.now()
  await payer.pay(made.invoice)
  const paid1 = await within(merchant.waitPaid(made.id), 3 * MINUTE, 'invoice 1 paid')
  ok(paid1.status === 'paid', 'the shop saw it paid', `${((Date.now() - t1) / 1000).toFixed(1)} s after the payer sent it`)
  ok(await until(() => Number(merchant.status().balance_ckb) - Number(before) === 0.5, MINUTE), 'the shop holds 0.5 CKB more', `${before} to ${merchant.status().balance_ckb}`)
  const read = await (await fetch(`${base}/v1/invoices/${made.id}`, { headers: { authorization: `Bearer ${apiKey}` } })).json()
  ok(read.status === 'paid', 'the API says paid')
  ok(await until(() => hooks.some((h) => h.type === 'invoice.paid' && h.id === made.id && h.valid), MINUTE, 500), "the shop's server got invoice.paid, signed", JSON.stringify(hooks))

  // 2. From the library, and the same order asked twice gets one invoice.
  const a = await merchant.createInvoice({ amount_ckb: 1, order_id: 'e2e-2', memo: 'Sticker pack' })
  const b = await merchant.createInvoice({ amount_ckb: 1, order_id: 'e2e-2', memo: 'Sticker pack' })
  ok(a.id === b.id, 'an order asked twice has one invoice')
  await payer.pay(a.invoice)
  const paid2 = await within(merchant.waitPaid(a.id), 3 * MINUTE, 'invoice 2 paid')
  ok(paid2.status === 'paid', 'paid again, 1 CKB')
  ok(await until(() => hooks.some((h) => h.type === 'invoice.paid' && h.id === a.id && h.valid), MINUTE, 500), 'and its webhook came')

  // 3. One nobody pays expires after its minute and the grace minute.
  const lapse = await merchant.createInvoice({ amount_ckb: 2, order_id: 'e2e-3', valid_minutes: 1 })
  ok(await until(() => merchant.get(lapse.id)?.status === 'expired', 3 * MINUTE, 5000), 'an unpaid invoice expired')
  ok(await until(() => hooks.some((h) => h.type === 'invoice.expired' && h.id === lapse.id && h.valid), MINUTE, 500), 'and the shop was told')
  ok(merchant.webhooksWaiting().length === 0, 'no webhook left undelivered')
} catch (e) {
  bad++
  say('FAILED:', String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 900))
} finally {
  api?.close()
  shop?.merchant.close()
  // Both close, after a failure too, so nothing stays in a channel (and the LSP gets its room back).
  for (const [name, s] of [['shop', shop?.session], ['payer', payer]] as const) {
    if (!s?.state.channel?.ready) continue
    try {
      await within(s.close(), 2 * MINUTE, `${name} close`)
      ok(await until(() => !!s.state.channel?.closed, 5 * MINUTE, 5000), `${name}'s channel closed`, s.state.channel?.stateName)
    } catch (e) {
      ok(false, `${name}'s channel closed`, String(e).slice(0, 200))
    }
  }
  receiver.close()
  say(bad ? `FAILED: ${bad}` : 'ALL PASSED')
  process.exit(bad ? 1 : 0)
}
