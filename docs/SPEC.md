# Fiber Web Payments (FWP), version 0.1

Status: **draft 0.1**, 2026-10-07. Testnet only. Written by LusoCryptoLabs; co-authors are
welcome. Parts marked *deployed* run on testnet today; parts marked *proposed* do not exist yet
and are open to change.

FWP lets a web site ask for a Fiber payment in one line, and lets any web checkout the person
uses answer it. No browser extension. Three parts, each usable alone: the ask (a link), the
answer (the payment, and an optional message back), and names (pay `alice.cell`).

## Terms

- **Site**: the page that wants to be paid. It runs, or uses, a Fiber node that makes its
  invoices.
- **Checkout**: the web page that pays for the person, from the person's own channel.
- **Payee**: whoever the invoice pays: the site, or a `.cell` name's holder.
- **Invoice**: a Fiber invoice string: `fibb...` on mainnet, `fibt...` on testnet, `fibd...`
  on a devnet. It carries the amount, the payment hash and its hash algorithm, the payee's
  public key and the expiry.
- **Paid**: see "What paid means" below. Nothing else in this document means paid.

## 1. The ask: a `web+fiber:` link

A site links to one of:

```
web+fiber:<invoice>
web+fiber:<name>?amount=<ckb>
```

- `<invoice>` is the whole invoice string, as made by the site's node.
- `<name>` is a `.cell` name, `amount` a decimal number of CKB (part 3).
- Optional query parameters, after the invoice or the name:
  - `origin`: the site's origin (`https://shop.example`), for the message back (part 2).
  - `return`: an https URL on the site's own origin to send the person back to, for the
    redirect answer (part 2).
  - `early=1`: the site takes `sent`, the answer once a name's LSP holds the payment, and
    follows the payment itself (part 2). Without it a checkout never answers `sent`.

Examples:

```
web+fiber:fibt1000000001plyr0jpm...
web+fiber:fibt1000000001plyr0jpm...?origin=https%3A%2F%2Fshop.example
web+fiber:maria.cell?amount=1
```

**Opening the person's checkout.** A checkout registers itself for the scheme, after the
person agrees, with `navigator.registerProtocolHandler('web+fiber', 'https://checkout.example/pay#%s')`.
The browser then opens that checkout for every `web+fiber:` link, with the whole link,
escaped, in place of `%s`. The checkout unescapes it and drops the `web+fiber:` prefix.

**Fallback.** With no checkout registered the browser does nothing useful, so a site also
offers a plain link to a default checkout it names, with the same text after `#`:

```
https://cellula.id/pay#fibt1000000001plyr0jpm...?origin=https%3A%2F%2Fshop.example
```

The part after `#` never reaches the checkout's server. A site may name any checkout; FWP
does not prefer one.

**What a checkout does with an ask.** It reads the invoice itself, never a server's
description of it, and refuses an invoice that:

- is for another network than the person's channel (`fibt` against a mainnet channel);
- has expired, or expires before the payment could settle;
- carries no amount (amountless invoices are not part of 0.1);
- does not match what the name's key signed (part 3), for an ask by name.

It shows the payee (and the payee's `.cell` name when it resolves one, part 3), the amount,
the most it may spend in fees, and the expiry, and pays only on the person's tap. It never
pays without one in 0.1.

## 2. The answer

**The answer is the payment.** The checkout pays the invoice from the person's channel. The
site learns it was paid from its own node: the invoice settles there. A site never counts a
payment from anything the checkout says.

**Optional: a message back to the opener** (*deployed* in the lab's checkout, testnet). When
the ask carried `origin` and the checkout was opened as a popup, it posts once to its opener:

```js
window.opener.postMessage(
  { type: 'fiber-pay', version: 1, payment_hash: '0x...', status: 'paid', preimage: '0x...' },
  origin,
)
```

- `status` is `paid`, `held` (the payment reached the payee's LSP, which keeps it until the
  payee is back: not paid, see below) or `failed`. `preimage` comes only with `paid`.
- `sent`, only when the ask said `early=1` and paid a name (*deployed* in the lab's checkout,
  testnet, since 2026-10-24): the name's LSP holds the payment; not paid. The person is free then,
  as an on-chain send frees them once signed, and the payer signs what is left when their wallet
  is next open. It carries `follow`, the link's status URL (part 3,
  `GET <gateway>/link/<id>/status?hash=<payment_hash>`, answering `{ delivery, here }`), which the
  site asks until `delivery` is `succeeded` or `failed`. Not before the LSP holds it: the node
  takes a payment a signing round before the channel commits it, and a checkout gone then leaves
  it half signed (seen 2026-10-25); the LSP's delivery record, made as its side commits, is the
  sign. An invoice shows no such sign, so it is answered when paid, early or not. A checkout may
  still post `paid` or `failed` after `sent` to an opener that is still there; a phone's answer,
  fetched once, is `sent` alone.
- The target origin is the `origin` the ask named. The browser delivers the message only if
  the opener really has that origin, so a site cannot read another site's answers by naming
  its origin.
- The site checks that the preimage hashes to the payment hash (with the invoice's
  algorithm: CKB hash, the default, or SHA-256) and still waits for its own node.
- The checkout page must not be cross-origin isolated (`Cross-Origin-Opener-Policy:
  same-origin`). With it, a site on another origin loses its popup's `opener` and gets no
  message, and a wallet the checkout opens as a popup (JoyID) loses it too.

**Optional: a redirect** (*deployed* in the lab's checkout, testnet). When the ask carried `return`, after the payment the
checkout offers a link back to `<return>#payment_hash=0x...&status=paid` (or `held`, or
`failed`), followed only on the person's tap. No preimage in a URL. The site checks with its own
node. The checkout takes `return` only on the origin the browser confirms sent the person (the
page's referrer has the `origin` the ask names), so a site that sends no referrer gets no link
back; since 2026-10-10, before which any https `return` was followed on its own.

## 3. Names: pay `alice.cell`

A name holder publishes, in the name's records, where invoices for it are kept and the key
that signs them. A checkout asked for `alice.cell` with an amount gets a fresh invoice for
that amount, checks the holder's key signed it, and pays it.

**The record** (*deployed*). Record key `fiber.link`, text:

```
<id>:<key>:<holder>
```

- `id`: twelve lower-case hex digits, the pay link's id.
- `key`: the compressed secp256k1 public key (33 bytes, hex) that signs the link's invoices.
- `holder`: the lock hash (32 bytes, hex) of whoever held the name when the link was
  published. A checkout offers the link only while the name's holder now is that lock: records
  go with a name when it changes hands, and a link left by a past holder must not be paid.
  The holder now: for a name held as a deed, the deed holder's lock hash, compared whole; for a
  name held directly, the owner as the name's account cell keeps it, which is only the first
  twenty bytes of a lock hash, compared with the first twenty bytes of `holder`.

**The pay link** (*deployed* at cellula's trial LSP, testnet). The link lives at the gateway of
the LSP the holder is a tenant of:

- `GET <gateway>/link/<id>`: the amounts on offer, as
  `{ "amounts": [{ "amount": "<shannons>", "available": n, "fits": true }], "here": bool, "seen": n, "receivable": "<shannons>" }`.
  `seen` is how many seconds ago the payee's page was last there (0 while it is, null when
  unknown). A payment the LSP holds for a payee who does not come back within about a day fails,
  so a payer may decline to pay a small amount to one not seen lately (cellula.id pays only one
  seen in the last 12 hours).
- `POST <gateway>/link/<id>/take` with `{ "amount": "<shannons>" }`: one invoice for that
  amount, as `{ "invoice", "payment_hash", "amount", "expires", "sig" }`. The gateway sets a
  taken invoice aside for 15 minutes and keeps only a few of each amount, so a checkout takes
  one when the person taps to pay, not when it shows the ask.
- `GET <gateway>/link/<id>/status?hash=<payment_hash>`: where that payment is, from the LSP's
  records: `null` (nothing reached the LSP), `deferred` (held for the payee, who is away),
  `dispatching`, `in_flight`, `settling_upstream`, `succeeded` or `failed`.

**The signature.** `sig` is a recoverable secp256k1 signature, by `key`, over

```
ckb_hash("cellula.id fiber meal:" + id + ":" + lowercase(payment_hash) + ":" + amount)
```

with `amount` in shannons as a decimal string and `ckb_hash` blake2b-256 with CKB's
personalization. The checkout reads the payment hash and amount from the invoice itself,
not from the gateway's answer, and pays only if the signature verifies against the record's
key. The gateway is not trusted to say whose an invoice is.

**Any source of invoices.** Because the check is the holder's signature, an invoice may come
from anywhere: the gateway's link, or the holder's own server making one on the spot and
signing it with the same key (a test server does this for `maria.cell`, so it never runs
out of invoices).

**Gaps in what is deployed** (*proposed* for 0.2):

- The record does not say where the gateway is; today it is implied (cellula's LSP). A field
  for it, or a second record (`fiber.pay`, an https URL), is needed before a second LSP.
- The signed text says "meal", from where it started (feeding a name's being). A neutral
  domain string is better, at the cost of changing every published link.
- Amounts on a link are whole CKB from 1 to 61 (a cell's minimum: below it a name cannot be
  paid on chain), made ahead. A free amount needs an invoice made
  on the spot, by the holder's server or by the holder's page while it is open.

## What paid means

A payment is **paid** when the invoice it was made for **settles at the payee**: the payee
has the money and the payer holds the preimage. An LSP that keeps a payment for a payee who
is away (`deferred`, or `held` in the message back) has not paid anybody yet; the payee's
page or server still has to take it, and it may fail back. A checkout may say "on its way"
for that state, never "paid". A site counts what its own node reports as settled, nothing
else.

## Security considerations

- **Never trust the checkout's word.** The message back and the redirect are hints for the
  page's flow. Access, goods and receipts follow the site's own node.
- **Check the invoice, not its description.** Network, amount, expiry, payee and payment hash
  come from the parsed invoice. A server that offers invoices (a gateway, a pay link) may
  swap them; for a name, the holder's signature is what proves an invoice is theirs.
- **The holder now, not the holder then.** A `fiber.link` whose `holder` is not the name's
  current holder is not offered.
- **One origin per message.** `postMessage` targets only the origin the ask named; a
  checkout never posts with `*`.
- **A tap per payment.** In 0.1 a checkout never pays without the person's tap. Budgets
  ("up to 20 CKB a day for this site") are a later section, once they are proven.
- **Fee caps.** The checkout caps fees for every payment and shows the cap. Ours: 1% plus
  0.01 CKB, the second part scaled down to 5% for payments under 0.2 CKB.
- **A registered handler is the person's choice.** Any page can register for `web+fiber:`,
  with the person's consent. A site cannot know which checkout answers, which is why it trusts
  only its own node.

## Not in 0.1

Amountless invoices; budgets; paying an invoice in parts across channels; recurring payments;
refunds. A checkout embedded in the site.

## Implementations

- **The lab's checkout** (*deployed*, testnet): `checkout.html` on the lab host takes
  `#<invoice>`, `?invoice=` and `web+fiber:`, pays from a channel the browser keeps (opening
  one first when there is none), answers by message or redirect, and offers to register for
  `web+fiber:` after a payment. It does not pay names yet.
- **cellula.id checkout** (*deployed* on testnet.cellula.id): the same at
  `/pay#<invoice>`, from the channel the person keeps in the app; and names, at
  `/pay#<name>.cell?amount=<ckb>`: it checks the link against the name's holder now, takes the
  invoice on the tap, and pays it only with the name's signature. Not on mainnet.
- **The Fiber session** (`vendor/fiber-session` in this repository): the browser and Node
  session both use: pays an invoice with a fee cap, makes invoices on demand, signs and checks
  pay-link invoices.
- **Cellula Checkout for sites**, the "Pay with Fiber" button (*deployed* on testnet.cellula.id, `button/pay-with-fiber.js` in
  this repository): one script,
  `pay-with-fiber.js`, served by the checkout. A button with `data-fiber-invoice`, or
  `data-fiber-name` and `data-fiber-amount`, opens the checkout in a small window with the page's
  origin, and gets `fiber-paid` (the message back, part 2) or `fiber-failed`.
- **The test page** (*deployed*, testnet): `fwp-test.html` on the lab host plays
  the site with its own channel and runs four cases against any checkout: the message back,
  the redirect, an expired invoice refused, and no message to an origin that did not ask.

## Prior art

Lightning's LNURL-pay and Lightning Addresses (pay a name, get a fresh invoice), WebLN (a
page asks the person's wallet to pay), BOLT 11 invoices. FWP differs in that the checkout is a
web page found through a registered scheme, and names are `.cell` records on CKB.
