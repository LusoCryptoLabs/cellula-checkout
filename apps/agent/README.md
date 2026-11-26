# Fiber agent (cellula-agent on npm)

An agent's own Fiber balance on testnet. It pays invoices and sellers' HTTP 402 answers by itself,
within caps the person sets, over an HTTP API on 127.0.0.1 that cellula-mcp (or any program with
its key) calls. See `docs/AGENTS.md` for the model and the 402 shape. Published as `cellula-agent`:
`NPM.md` is its README there, `scripts/pack.mjs` makes the package in `npm/`.

```sh
node scripts/build.mjs                       # dist/agent.mjs, the signer in dist/signer/
node dist/agent.mjs key
```

`key` makes the agent's testnet key and the API key in `~/.cellula-agent` (never over one already
there) and prints the address. Fund it: the first channel needs what it opens with, the 100 CKB
reserve, the LSP's opening fee if it asks one, and 61 for the change, plus the fee. The fee is set by
each LSP; the testnet LSP asks none today. 700 CKB covers a 20 CKB channel with room to spare.

```sh
node dist/agent.mjs --return-to ckt1... --open 20 --per-payment 1 --total 10
```

The flags are the one way to set it that reads the same in PowerShell, cmd and bash, which share
no `NAME=value command` (`config.ts` FLAGS). Each stands for an environment variable, which works
too; one on the line wins:

| flag | variable |
| --- | --- |
| `--return-to`, `--per-payment`, `--total` | `AGENT_RETURN_TO`, `AGENT_PER_PAYMENT_CKB`, `AGENT_TOTAL_CKB` |
| `--day`, `--approve-above`, `--allow`, `--open` | `AGENT_DAY_CKB`, `AGENT_APPROVE_ABOVE_CKB`, `AGENT_ALLOW`, `AGENT_OPEN_CKB` |
| `--dir`, `--port`, `--approver` | `AGENT_DIR`, `PORT`, `AGENT_APPROVER` |

| setting | |
| --- | --- |
| `AGENT_DIR` | the channel and the payments, keep it like a key (`~/.cellula-agent`) |
| `AGENT_KEY_FILE` | the agent's key (`key` in `AGENT_DIR`) |
| `AGENT_API_KEY` or `AGENT_API_KEY_FILE` | the local API's key, 16 characters or more (`api.key` in `AGENT_DIR`) |
| `AGENT_RETURN_TO` | required: the person's address a taken-out balance goes to |
| `AGENT_OPEN_CKB` | what the channel holds to spend, 10 to 1,000 (20) |
| `AGENT_PER_PAYMENT_CKB`, `AGENT_TOTAL_CKB` | required: the most one payment can be, and all together |
| `PORT`, `HOST` | 8280 on 127.0.0.1; `HOST` can be `::1` or `localhost`, nothing off this machine |
| `AGENT_FETCH_PRIVATE` | `1` lets `/v1/fetch` reach this machine and its network, to test a seller here; unset otherwise |
| `AGENT_DAY_CKB` | optional: the most in any 24 hours, counted back from each payment |
| `AGENT_ALLOW` | optional: the sellers' host names and payees' node keys it may pay, separated by commas; unset, any |
| `AGENT_APPROVE_ABOVE_CKB` | optional: a payment above this waits for your approval on the approvals page; below the per-payment cap |
| `AGENT_APPROVER` | optional: the person's wallet address (ckt1), whose signatures approve, refuse, stop, resume and take out from the phone; unset, no phone |
| `AGENT_RELAY`, `AGENT_PHONE_PAGE` | the relay (https://agent-relay.lusocryptolabs.com) and the phone page (https://testnet.cellula.id/agent), https only |

It does not start without the caps and the return address. Until the address holds enough it says
so and tries again every minute. It starts itself again when a channel is renewed, so it needs no
service manager.

Beside a running agent, `node dist/agent.mjs status` prints what it holds and has left, and
`node dist/agent.mjs take-out` takes the balance out to `--return-to` and waits for the
transaction, both through the API with the key in `AGENT_DIR` (no curl, which PowerShell 5.1 maps
to another command). The approvals page has a "Take it all out" form too, sent only with its box
ticked, checked on the server as well.

## Your approvals page

When it starts, the agent prints a link to `http://127.0.0.1:8280/approvals/sign-in?key=...`. The
key is made fresh at each start and printed only there; opening the link lets that browser in.

- A payment above `AGENT_APPROVE_ABOVE_CKB` waits there, with the seller, what is bought and the
  amount. Approved, the next payment to that seller and payee, up to that amount, goes once, within
  10 minutes. Refused, it is refused for 10 minutes. The caller is told `needs_approval` with the
  page's address, or `refused_by_person`.
- "Stop every payment" refuses all of them (`paused`) until you let it pay again, a restart
  included.
- It shows what was paid and what was refused lately: what a model tried.

The API's key does not open it, a form posted from another page is refused, it answers only on
this machine's own names, and no other page can frame it. An approval does not lift the caps.

## On the phone

With `--approver`, the agent also prints `https://testnet.cellula.id/agent#phone=<token>.<mark>`. The
page reads the agent through `apps/agent-relay` and shows the same buttons; each one has the
person's Cellula wallet sign words, which the page posts to the relay. `agent-phone.ts` runs in the
agent: every 3 s it posts what newly waits, reads the answers, and acts on one only if

- its words are, byte for byte, the approve or refuse words the agent wrote for an approval still
  waiting (`askMessages` in `phone-sign.ts`: the agent, amount, seller or payee, what for, the
  approval's id and when it ends), or a command it reads back exactly (`readCommand`: stop, let it
  pay again naming the stop it undoes, or take out to `AGENT_RETURN_TO` and nowhere else, asked
  within 10 minutes, with a nonce not used before, kept in `phone.json` across restarts);
- and `checkSigned` says yes: the signature verifies for its sign type (a Cellula account passkey,
  the post-quantum key, or one CCC verifies, JoyID and a CKB key among them), and the locks of its
  signer (cellula-sdk's `locksForIdentity`) include `AGENT_APPROVER`'s. When the check itself
  fails (the chain not read just then), the answer is checked again for 15 minutes, not dropped.

What the relay sends is bounded (a reply of 256 kB, 10 signatures checked a round), and which
answers were seen is kept in `phone.json`, not counted by the relay, so one that forgets, starts
again or lies about its count makes the agent miss nothing; what still waits is posted again when
the relay no longer holds it. A stop always stops. Each stop is named anew (`paused_id`, in the
status), and a go-again undoes only the one it names, so one held back past a later stop (on either
page) does nothing, whatever the phone's clock.

So the relay can withhold or delay an answer, or show the page a wrong status, and nothing more:
the page draws each card from the words the wallet will sign (the wallet's `readAsk`), Stop is
always on it, and the link carries the agent's mark (`#phone=<token>.<agentMark>`), so the page
signs nothing for another agent the relay shows. The secret and the token are in `phone.json`; the token is made from the secret
(`phoneToken`), so a relay takes a new token only from its agent, and the caller of the API is not
given the link. It stays the same across restarts; another `--approver` makes a new one, since the
relay binds a token to its first approver.

## What it guards, and what it does not

- The caps and the return address hold whatever a model driving the agent is told: the API cannot
  change them, and a take-out goes only to `AGENT_RETURN_TO`. The same holds for the 24-hour cap,
  the allowed sellers and payees, and the approval amount.
- A seller is the host the agent itself fetched: `/v1/pay` takes none from its caller, so an
  invoice given as is passes `AGENT_ALLOW` only by its payee's key.
- The API listens on this machine only, since its key goes with every call in plain HTTP.
- `/v1/fetch` reaches the public internet only. An address on this machine or its network (a
  router, a cloud machine's metadata, a local service) is refused, checked on the address each
  connection uses, so a name that points inside is refused too.
- The key file and `AGENT_DIR` are the balance: whoever can read them, someone with your account on
  this machine included, can spend it, caps or not, as with any wallet on a computer. Keep on the
  agent only what you would lose without much thought.
- Testnet only.

## API

All but `/health` and `/approvals` need `Authorization: Bearer <api key>`. Refusals by what the
person set: `over_cap` (422), `not_allowed` (403), `needs_approval` (403), `refused_by_person`
(403), `paused` (423). Others: `https_only` (400, a seller asked over plain HTTP, where its receipt
would cross the network in the clear), `payment_pending` (409, a payment for the same request still
on its way), `too_many_waiting` (429, 50 approvals waiting or refused lately).

| route | |
| --- | --- |
| `GET /v1/status` | balance, spent, caps and what is left, the address to top up, a take-out under way |
| `POST /v1/pay` `{invoice, max_ckb?, memo?}` | pays an invoice that names its amount: 200 paid with its preimage, 202 sending |
| `POST /v1/fetch` `{url, max_ckb, method?, headers?, body?}` | fetches a public URL and pays its 402 once, then asks again with the receipt; 403 `not_public` for one on this machine or its network; 400 for a header that changes where it goes (`Host`, `Transfer-Encoding`, `X-Forwarded-*`, ...); 60 s at most a request |
| `GET /v1/payments`, `GET /v1/payments/<hash>` | the payments and their receipts |
| `POST /v1/take-out` | closes the channel and sends the balance to `AGENT_RETURN_TO`; takes no address |

## With cellula-mcp

```sh
claude mcp add cellula npx cellula-mcp@0.4.1 -e CELLULA_NETWORK=testnet
```

cellula-mcp 0.4.1 reads the API key from `~/.cellula-agent/api.key` and calls 127.0.0.1:8280 when
nothing else is set, so the line holds no path. No `--` before the command either: Windows
PowerShell 5.1 drops it on its way through npm's `claude.ps1`, and `claude mcp add x -- npx -y ...`
fails there with "unknown option '-y'" (Claude Code 2.1.284, 2026-11-01). npx needs no `-y` when
an MCP client starts it, since its input is not a terminal. The line above connected from
PowerShell, cmd and Git Bash alike. Name the version: `npx cellula-mcp` asks the registry each
start (15 to 19 s on 2026-11-01, near Claude Code's 30 s limit for a server; one start timed out),
with the version 2.2 s.
