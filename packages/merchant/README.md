# pay-with-fiber

Cellula Checkout's merchant kit: take Fiber payments on a server. Testnet only.

A shop's server makes an invoice for an order, learns it was paid when its own signer releases the
invoice's secret, and gets a signed webhook. Underneath is the Fiber session (`vendor/fiber-session`) running on
the server (`nodeHost`): the shop is a tenant of the hosted LSP, with its channel and keys on its own
disk. The page side is `pay-with-fiber.js`, served at `https://testnet.cellula.id/pay-with-fiber.js`
(cellula.id, mainnet, does not serve it yet), which opens the person's checkout.

## In a Node shop

The package is not on npm (`"private": true`). In this workspace
`npm install` links it as `pay-with-fiber`, and the apps here import its files by path. A shop
elsewhere copies `packages/merchant` together with `vendor/fiber-session`, in the same layout (the
kit imports the session by a relative path), or runs the bundled service below.

The page needs no package: a `<script src="https://testnet.cellula.id/pay-with-fiber.js">` tag, or a
copy of `button/pay-with-fiber.js`. Pasted inline, the copy opens the testnet wallet; served from
the shop's own host, its tag needs `data-checkout="https://wallet.testnet.cellula.id"`, or it looks
for the checkout on that host.

```ts
import { startMerchant } from 'pay-with-fiber'

const { merchant } = await startMerchant({
  dir: '/var/lib/shop-fiber',             // channel3.json + merchant.json: keep it like a key
  key: process.env.SHOP_TESTNET_KEY,      // funds the channel's 100 CKB reserve, gets it back on close
  webhook: { url: 'https://shop.example/hooks/fiber', secret: process.env.FIBER_WEBHOOK_SECRET },
})

const inv = await merchant.createInvoice({ amount_ckb: '2', order_id: 'A-1001', memo: 'Espresso' })
// to the page: <button data-fiber-invoice="${inv.invoice}">Pay with Fiber</button>
await merchant.waitPaid(inv.id) // or merchant.on('paid', fn), or the webhook
```

The first start opens a channel from the key and waits until it is ready, about a minute and a
half on testnet. The key puts in 10 CKB to spend (unless `openCkb` says otherwise), the 100 CKB set
aside (back on close) and, the first time a wallet opens one on LSP3, the LSP's opening fee of 500
CKB, once: 610 CKB, and with the funding's fee and its change cell the key needs 672 at least. The
merchant pays the fee from the channel as soon as it is ready, as the Cellula wallet does, and tries
again a minute after a failure. Until it is paid the channel takes no payment: `status().ready` is
false and `createInvoice` answers `not_ready`.

## Agents and HTTP 402

The same session pays too. `startAgent()` opens an agent's own balance from its own key, and
`Agent` pays invoices within caps the person sets; `paywall()` answers a route with HTTP 402 and a
Fiber invoice, and `fetchPaid()` pays one and asks again. See `docs/AGENTS.md`.

```ts
import { paywall, Receipts, LSP3_PUBKEY } from 'pay-with-fiber'

const receipts = new Receipts('/var/lib/shop-fiber/receipts.json')
const gate = paywall(merchant, { price_ckb: '0.1', payTo: LSP3_PUBKEY, receipts })
http.createServer(async (req, res) => {
  if (!(await gate(req, res))) return // answered 402
  res.end('paid content')
})
```

## From any other language

Bundle the service and run it beside the shop:

```sh
node scripts/build.mjs           # dist/merchant.mjs, the signer's wasm in dist/signer/
MERCHANT_DIR=/var/lib/shop-fiber MERCHANT_KEY_FILE=/etc/shop/fiber.key MERCHANT_API_KEY=... \
MERCHANT_WEBHOOK_URL=https://shop.example/hooks/fiber MERCHANT_WEBHOOK_SECRET=... \
PORT=8262 node dist/merchant.mjs
```

| Route | Does |
|---|---|
| `POST /v1/invoices` `{amount_ckb, memo?, order_id?, metadata?, valid_minutes?}` | 201 and the invoice |
| `GET /v1/invoices/<id or payment hash>` | the invoice |
| `GET /v1/invoices?status=open\|paid\|expired&order_id=&limit=` | `{data: [...]}`, newest first |
| `GET /v1/balance` | `{ready, can_receive_ckb, balance_ckb}` |
| `GET /health` | `{ok, ready}`, no key |

Every other route takes `Authorization: Bearer <MERCHANT_API_KEY>`. Errors are
`{error: {code, message}}`: `invalid_amount` and `invalid_request` (400), `unauthorized` (401),
`not_found` (404), `order_paid` (409), `too_large` (422), `not_ready` (503), and `internal` (500)
for anything else. Renting room (below) adds `busy` (409, room is moving to the next channel),
`no_room` (501, renting is not set up) and `rent_failed` (502, the LSP's refusal). In Node,
`waitPaid` also fails with `expired` (410) and `timeout` (408); each `MerchantError` carries its
`code` and `status`.

```sh
curl -s localhost:8262/v1/invoices -H "authorization: Bearer $KEY" \
  -d '{"amount_ckb":"2","order_id":"A-1001","memo":"Espresso"}'
```

An order asked for again while its invoice for the same amount is open gets that invoice, so a
retried request never makes two. A paid order is not invoiced again.

## Webhooks

`POST` to the shop's URL with the event as JSON, `{id, type, created, data: {invoice}}`, for
`invoice.paid` and `invoice.expired`. The header `Fiber-Signature: t=<unix seconds>,v1=<hex>` is
the HMAC-SHA256 of `<t>.<raw body>` with the shared secret, as Stripe signs. Check it on the raw
body, before parsing:

```ts
import { verifyWebhook } from 'pay-with-fiber/webhook'
if (!verifyWebhook(rawBody, req.headers['fiber-signature'], secret)) return res.writeHead(400).end()
```

A delivery that does not get a 2xx is tried again after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h and
24 h, across restarts.

## More room to receive

One payment brings at most the channel's room to receive. A shop paid more than that rents more
room from the LSP, at its price per 30 days (`roomTerms()` says it, or null when the LSP rents none):

```ts
await merchant.roomTerms()                       // { per_month, least_ckb, most_ckb, month_days } or null
await merchant.rentRoom({ room_ckb: 5000, months: 1 })
merchant.rents()                                 // unpaid, waiting, moving, running, ended
merchant.onRoom('room.ending', (rent) => ...)    // a week before a rent ends
```

The rent is paid from the shop's channel and the room comes with its next channel with the LSP,
once no invoice is open (or at once with `placeRoom()`, or only then with `roomPlace: 'manual'`):

- **Hosted** (`startMerchant`): the channel is taken out and the process ends with 75 for the
  service to start it again; the next start moves the rent to the new channel (a new tenant) and
  opens it with the room. Invoices are refused for the minute or two this takes.
- **On its own node** (`startOwnNodeMerchant`): the node opens a second channel to the LSP, with
  109 CKB unless told (`roomOpenCkb`).

A rent paid while one of as much room runs starts at its end and needs no new channel: that is how
a rent is renewed. When a rent ends the LSP funds the default again and, a week later, closes the
channel the rent paid for; renew before then to keep it. The webhooks say `room.placed`,
`room.ending` and `room.ended`, with `{rent}`.

Over HTTP: `GET /v1/room` (terms and rents), `POST /v1/room/rent` `{room_ckb, months?}`,
`POST /v1/room/place`. A node without the kit: `node scripts/rent-room.ts --node <rpc url> --room
5000` (`--terms`, `--status <hash>`, `--no-open`).

## What paid means

Paid means this shop's signer released the invoice's secret: the money is in the shop's channel.
The checkout's message to the page (`fiber-paid`) is a hint for the page, not proof for the shop.
It carries the preimage when the checkout itself answers `paid`, as it does for an invoice. A name
paid early (`data-fiber-early`, or `onSent`) is answered `sent`, then `paid` from the gateway's
link status (or left at `sent` when the page cannot read it), and neither carries one. An invoice
nobody pays expires a minute after its time.

## Limits

- Testnet only, through LSP3, the hosted Fiber LSP that LusoCryptoLabs runs on testnet. The vendored
  signer refuses a channel saved by an older line of the LSP. Mainnet is not served yet.
- One payment brings at most the channel's room to receive: what the gateway's `/capacity` says
  as `room` for a new channel, more when rented (above). Each payment received
  moves room to the shop's side.
- The shop should stay up. A payment that comes while it is down is held by the LSP for about a day
  or until the invoice expires, and lands when the shop starts again.
- One process per data directory.
- The LSP caps the channels one key may have open at once (its cap per wallet). A start
  whose key is at the cap opens nothing and says so in its log; take one of them out first. A shop
  holds one channel, so only a second shop or a test on the same key gets there.
- `channel3.json` holds the channel's secrets in the clear (`channel.json` was an older line's).

## Tests

`npm test`: the rules against a fake session (orders asked twice, paid once, paid while down,
expiry, webhook signatures and retries, the HTTP API, renting room, the opening fee), and the
session's own refusal of an opening at the LSP's cap per wallet.
`scripts/room-drill.ts` rents room for a hosted shop on testnet (with the gateway's renting on): `node
scripts/build.mjs room` then run `dist-room/room-drill.mjs` until it says done.
`scripts/e2e.ts` runs a shop and a payer on testnet through LSP3:
`node scripts/build.mjs e2e && E2E_KEYS=<file of two keys> node dist-e2e/e2e.mjs` (each key about
700 test CKB the first time: the opening fee is once per wallet).
