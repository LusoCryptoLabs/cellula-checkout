# Cellula Checkout

Take Fiber payments on a website, and let an AI agent pay for APIs from its own Fiber balance, on
CKB. It runs on the CKB testnet today; mainnet is not served yet. The product was first called
Pay with Fiber: the button still says "Pay with Fiber", and the files and the workspace packages
keep that name.

## What is here

- `packages/merchant`: the Checkout seller kit, the shop's server side. An invoice per order, paid
  when the shop's own signer releases it, signed webhooks, and an HTTP API for shops written in
  other languages. It also holds the agent's core (`agent.ts`) and HTTP 402 support (`x402.ts`).
- `button/pay-with-fiber.js`: the page side. One script and a button; the person pays from their
  own wallet's checkout. testnet.cellula.id serves a copy at
  `https://testnet.cellula.id/pay-with-fiber.js`.
- `apps/shop`: a demo shop that uses both, at https://fiber-shop.lusocryptolabs.com.
- `apps/agent`: cellula-agent, an agent's own Fiber balance. It pays invoices and sellers' HTTP 402
  answers within caps the person sets, behind a local API that MCP clients call through
  cellula-mcp. See `docs/AGENTS.md` and `apps/agent/NPM.md`.
- `apps/agent-relay`: the approvals relay. It carries what an agent waits on to the person's
  phone, and what the person's wallet signed back. Neither side trusts it.
- `vendor/fiber-session`: the Fiber session all of the above run on (see
  `vendor/fiber-session/VENDORED.md`).

Each package's README says how to run it. The ask and the answer between a site and a checkout
follow Fiber Web Payments (`docs/SPEC.md`), so another wallet can answer them too. `docs/OWN-NODE.md`
covers a shop on its own Fiber node.

## Install, test, build

Node 24 (what CI uses) and npm.

```sh
npm ci
npm run typecheck
npm test
npm run build      # packages/merchant/dist/merchant.mjs and each app's dist/
```

The tests run offline against fakes. Running a shop or an agent for real needs testnet CKB from
the faucet (https://faucet.nervos.org) and talks to LSP3, the hosted Fiber LSP on testnet. The
channel signer is here compiled; its source is not. `vendor/fiber-session/VENDORED.md` says what
the build is, its hashes and its licences.

## Security

Please report a security issue privately to hello@lusocryptolabs.com, not in a public issue. See
`SECURITY.md`.

## License

MIT, see `LICENSE`.
