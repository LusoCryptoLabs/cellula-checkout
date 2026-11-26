# Agents and HTTP 402

An agent can hold its own Fiber balance and pay for APIs by itself, within caps a person sets. A
seller puts a paywall in front of a route and answers HTTP 402 with a Fiber invoice. Testnet only.

- `packages/merchant/src/agent.ts`: the agent. Pays invoices that name their amount, checks the
  caps before the signer is asked, keeps each receipt, takes the balance out.
- `packages/merchant/src/x402.ts`: `paywall()` for a seller and `fetchPaid()` for a buyer.
- `packages/merchant/src/agent-http.ts`: the agent's local HTTP API, for cellula-mcp or a script.
- `apps/agent`: the agent as a program a person runs. See its README.
- An example seller runs at https://fiber-names-api.lusocryptolabs.com (its source is not in this
  repository).

## Who holds what

The agent's channel is opened from the agent's own key, on the machine it runs on, like the
merchant's. Nothing is held by us: the LSP cannot sign for the agent.

The person sets three things when starting the agent, in its environment, and it does not start
without them:

- `AGENT_PER_PAYMENT_CKB`: the most one payment can be.
- `AGENT_TOTAL_CKB`: the most all payments together can be.
- `AGENT_RETURN_TO`: the address a taken-out balance is sent to.

The API cannot change any of them. A model driving the agent over MCP can be told anything by a
page it reads; the most it can make the agent spend is what the caps allow, and it cannot name
where the money goes back to. `POST /v1/take-out` takes no address.

The balance itself is a cap too: a channel holds only what was put in.

The API listens on this machine only (its key goes in plain HTTP), and `POST /v1/fetch` reaches
the public internet only (`packages/merchant/src/public-fetch.ts`): a misled model cannot use the
agent to read a router, a cloud machine's metadata or a local service. `AGENT_FETCH_PRIVATE=1`
lifts that, for a person testing their own seller on this machine.

What the caps do not hold: the key file and `AGENT_DIR` are the balance, and whoever can read them
can spend it, as with any wallet on a computer. Keep little on an agent.

The person can also set, all optional and none changeable over the API (`agent.ts`):

- `AGENT_DAY_CKB`: the most in any 24 hours, counted back from each payment.
- `AGENT_ALLOW`: the sellers (the host the agent fetched, never one its caller names) and payees
  (node keys) it may pay.
- `AGENT_APPROVE_ABOVE_CKB`: a payment above it waits on the person's approvals page
  (`agent-approvals.ts`), which takes its own key, printed only in the agent's terminal. An approval
  lets one payment go: an invoice given as is by its payment hash, a seller's next invoice by
  seller, payee and an amount no larger. The page also stops every payment, kept across a restart.
- `AGENT_APPROVER`: the person's wallet. The same approvals, the stop, going again and the take-out
  can then be done from their phone, each signed by that wallet (below).

## From the phone

The approvals page is on the agent's machine, so a person away from it could not answer. With
`AGENT_APPROVER`, the agent (`agent-phone.ts`) posts what waits to a relay (`apps/agent-relay`),
and a page on the names site (testnet.cellula.id/agent#phone=<token>) shows it. The person taps
Approve, Refuse, Stop, Let it pay again or Take it all out; their Cellula wallet shows the words and
signs them with its passkey; the page posts the signature to the relay; the agent reads it there.

The agent does not trust the relay. It acts only on words it wrote itself (an approval's words name
the agent, amount, seller, what for, the approval's id and when it ends; a command names the agent,
the return address for a take-out, the time and a nonce), and only when the signature verifies and
its signer's lock is the approver's (`signedBy`, `phone-sign.ts`). A command is good for 10 minutes
and once, its nonce kept across restarts, and a stop or go-again signed before the last change does
nothing. The relay checks the same before it keeps an answer, so another wallet costs the agent
nothing, but that check is for the relay's sake. The page draws each payment from the words the
wallet will sign, not from what the relay says beside them, and always shows Stop. A relay that
lies can withhold or delay an answer, or show the page a wrong status; it cannot approve, stop,
resume or take out, and a take-out goes to the return address only.

What the relay sees: the addresses, the status, and each waiting payment's amount, seller and memo,
with the answers. Without `AGENT_APPROVER` the agent sends it nothing.

## HTTP 402 over Fiber

The shape is x402 v2 (`coinbase/x402`, `specs/transports-v2/http.md`) with the `exact` scheme
proposed for Fiber in nervosnetwork/fiber#1301 (open, not merged). That proposal does not say how
the invoice reaches the buyer; here it rides in the requirement's `extra.invoice`.

1. The buyer asks. The seller answers `402` with a `PAYMENT-REQUIRED` header (base64 JSON) and the
   same object as the body:

   ```json
   {
     "x402Version": 2,
     "resource": { "url": "https://fiber-names-api.lusocryptolabs.com/v1/names/maria.cell" },
     "accepts": [{
       "scheme": "exact", "network": "fiber:testnet", "asset": "ckb",
       "amount": "10000000", "payTo": "032c85c1...", "maxTimeoutSeconds": 600,
       "extra": { "invoice": "fibt100000001..." }
     }]
   }
   ```

   `amount` is in shannons. `payTo` is the invoice's payee: for a seller hosted on the LSP, the
   LSP's node key.

2. The buyer pays the invoice and asks again with a `PAYMENT-SIGNATURE` header:
   `{"x402Version": 2, "accepted": <the requirement>, "payload": {"invoice": "...", "paymentPreimage": "0x..."}}`.

3. The seller checks the requirement, that the preimage hashes (CKB's blake2b or sha256) to one of
   its own invoices at this price, that its channel has it paid, and that the receipt was not used.
   It answers the route with a `PAYMENT-RESPONSE` header: `{"success": true, "transaction":
   "fiber-receipt:<payment hash>"}`.

A receipt opens one request. All paywalls of one shop share one `Receipts` register, so a receipt
never opens two routes. When the route cannot answer after the check (the names API when the chain
does not), it gives the receipt back with `receipts.release()` and the buyer asks again with it.

`fetchPaid()` refuses a 402 it cannot pay before anything is paid: another network or asset, no
invoice, more than `max_ckb`, or an invoice that asks more than the requirement says.

## Limits

- Every unpaid request makes an invoice: a seller in the open should limit requests per client.
- A payment takes seconds, so per-request pricing suits slow calls; bundles suit many small ones.
- The agent's first channel pays the LSP's opening fee, once per wallet, like any other.
- The caps count what sellers ask; the routing fee is on top, at most
  `amount/100 + min(amount/20, 0.01 CKB)` by the signer (`feeCap`). Counting it in the caps would
  make a 1 CKB invoice miss a 1 CKB per-payment cap, so it is left out of them, and NPM.md says so.
- A take-out asked while a payment is on its way waits for it (`waiting`), starts no other payment,
  and closes once it ends. A seller answering with a hold invoice can keep one on its way up to 14
  days (the signer's `max_tlc_expiry_ms`), and the take-out with it.
- What reaches the agent's address after a take-out (a close the indexer shows late) is sent on to
  the return address, and a folder taken out once opens a new channel when started with CKB at its
  address.
- Whoever can read `AGENT_DIR` has the balance, caps or not; an AI client with file or shell tools
  on the same account can. Give it the cellula tools only, and start the agent in your own
  terminal, where the approvals link is printed.
- `/v1/fetch` refuses NAT64 addresses (`64:ff9b::/96`) with the rest, so on an IPv6-only network
  that reaches IPv4 through NAT64 a seller on IPv4 cannot be fetched.
