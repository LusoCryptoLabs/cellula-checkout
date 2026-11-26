# A shop on its own node

Where Cellula Checkout (then called Pay with Fiber) is going (2026-10-12): a shop runs everything
itself, with no hosted service in between. The kit has two modes: a tenant of the hosted LSP (`startMerchant`,
`LAB_GATEWAY` in `packages/merchant/src/lsp3.ts`), and since 2026-10-13 the shop's own node (`startOwnNodeMerchant`,
`NodeSession` in `packages/merchant/src/node-session.ts`). Below, what was measured before the mode
was written, then the mode.

## The mode (2026-10-13)

`NodeSession` is the merchant's session over the node's JSON-RPC: `new_invoice` with a preimage
the node keeps and settles itself, `get_invoice` every few seconds for open invoices, and
`list_channels` for what the shop holds and can receive (the peers' side of its ready channels).
Paid means the node says Paid. Invoices made before a restart are looked up again on start, so a
payment that landed while the shop's process was down still counts. The demo shop runs it when
`FIBER_NODE_RPC` is set (and `FIBER_NODE_TOKEN_FILE`, when the node's RPC asks for a Biscuit token).

Seen on testnet, 2026-10-13 01:57 to 01:59 UTC: the kit's merchant on this mode, talking to a
test shop's node over a tunnel, made a 1 CKB invoice; a fresh Cellula wallet topped up
a quick balance and paid it through LSP2; the merchant said paid at 01:59:51, the node's balance
409 to 410 CKB. Tests: `test/node-session.test.ts` (paid only once the node says so, paid while
down, no channel no invoice; a control with another node's state).

The wallet's LSP has a public channel into the network since 2026-10-13 01:27 UTC
(1,000 test CKB to `0262dafc…`, the best connected public node). LSP2 paid this shop through that
node alone (a route fixed to it) at 01:56 UTC, fee 0.001 CKB, once the public node had room on its
side toward the shop: a shop needs inbound room from the public side, which the shop's own
5 CKB keysend to the public node gave here. A real shop buys or is given that room.

## Room to receive, rented (2026-10-14)

A shop's node needs room on the LSP's side to be paid. Where the LSP rents it,
`node packages/merchant/scripts/rent-room.ts --node <rpc url> --room 5000` asks with
the node's key, pays the LSP's invoice from the node and opens a second channel that gets the room
(`--no-open` to open it yourself). `startOwnNodeMerchant` does the same through `rentRoom`, and says
`room.ending` a week before the end. Seen on testnet, 2026-10-14: the command, against a test hub node
(fnn 0.9.1) through a tunnel, rented 2,000 CKB for 20 test CKB and LSP2 funded the new channel
2,000 to receive; it was then closed.

## Measured on testnet, 2026-10-12

- A shop node, official fnn 0.9.1 with Fiber's testnet config, opened a public channel of 500 CKB
  to the best connected public node (`0262dafc…`, 545 channels). Its side: 401 CKB. The other
  side: 0. A public node that accepts a channel puts in only its reserve and the closing fee
  (`DEFAULT_AUTO_ACCEPT_CHANNEL_CKB_FUNDING_AMOUNT` in fiber's `config.rs`), so a new shop has no
  room to receive.
- The wallet's LSP had 40 channels, all private (its tenants and a test hub), and the hub had none
  in public: a Cellula wallet could not reach a node outside.
- With a channel of 200 CKB from the hub to the shop, standing in for an operator who agrees to
  fund a shop's side, a Cellula wallet on the LSP paid the shop's own invoice in 2.9 s (wallet,
  LSP, hub, shop). The shop's node said `Paid` and held 2 CKB.

## What that means for the mode

- A shop needs someone to put CKB on the other side of a channel with it. No code removes that;
  it is how channels work. Today: ask an operator to open a channel to the shop. Later: buy one
  from an LSP, once Fiber releases its own (#1623).
- For Cellula wallets to pay shops outside, the wallet's LSP needs a public channel into the
  network. That is the wallet's side, not the kit's.
- The mode itself talks to the shop's fnn: `new_invoice`, `get_invoice`, `list_channels`.
