// The merchant as a small service beside a shop written in any language (bundled to one file by
// scripts/build.mjs, with the signer's wasm beside it):
//
//   MERCHANT_DIR=/var/lib/my-shop-fiber        channel3.json + merchant.json (keep it like a key)
//   MERCHANT_KEY_FILE=/etc/my-shop/fiber.key   the shop's testnet key, hex
//   MERCHANT_API_KEY=...                       what the shop's server sends as Bearer
//   MERCHANT_WEBHOOK_URL=https://shop/hooks    optional, with MERCHANT_WEBHOOK_SECRET
//   MERCHANT_OPEN_CKB=10  PORT=8262  HOST=127.0.0.1  FIBER_GATEWAY=...
//   node merchant.mjs

import { readFileSync } from 'node:fs'
import { startMerchant } from './start.ts'
import { serveMerchant } from './http.ts'

const need = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

const webhookUrl = process.env.MERCHANT_WEBHOOK_URL
const { merchant } = await startMerchant({
  dir: need('MERCHANT_DIR'),
  key: readFileSync(need('MERCHANT_KEY_FILE'), 'utf8').trim(),
  openCkb: Number(process.env.MERCHANT_OPEN_CKB ?? 10),
  webhook: webhookUrl ? { url: webhookUrl, secret: need('MERCHANT_WEBHOOK_SECRET') } : undefined,
  gateway: process.env.FIBER_GATEWAY,
  log,
})
const port = Number(process.env.PORT ?? 8262)
const host = process.env.HOST ?? '127.0.0.1'
await serveMerchant(merchant, { port, host, apiKey: need('MERCHANT_API_KEY'), log })
log(`merchant API on http://${host}:${port}`)
