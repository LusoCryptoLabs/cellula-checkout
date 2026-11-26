# Fiber demo shop

A shop paid over Fiber on testnet, to show Cellula Checkout's merchant kit and its button together.
The server makes an invoice for each order from its own channel (`packages/merchant`); the
page opens the person's checkout with `pay-with-fiber.js`; the order is paid when the shop's signed
webhook says so, or when the shop asks its own merchant. Never from the page's word.

```sh
node scripts/build.mjs
SHOP_DIR=/var/lib/fiber-shop SHOP_KEY_FILE=/etc/fiber-shop.key PORT=8263 node dist/shop.mjs
```

`SHOP_KEY_FILE` holds the shop's testnet key (hex); fund its address first (the log prints it), with
672 test CKB at least the first time, the LSP's opening fee of 500 among them (packages/merchant
README). The first start opens the shop's channel and pays the fee, about a minute and a half; the
page says so meanwhile.
`PAY_SCRIPT` points at another copy of the button's script (default testnet.cellula.id's).
