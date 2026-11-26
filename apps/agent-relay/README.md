# Agent relay

Carries what a Cellula agent waits on to its person's phone, and what the person's wallet signed
back. The agent (`packages/merchant/src/agent-phone.ts`) and the page
(testnet.cellula.id/agent#phone=..., a page of the Cellula wallet) both reach it over HTTPS; neither trusts it.
Testnet, at https://agent-relay.lusocryptolabs.com.

```sh
node scripts/build.mjs           # dist/relay.mjs
RELAY_PORT=8271 RELAY_STATE=/var/lib/agent-relay/state.json node dist/relay.mjs
```

| Setting | Does |
|---|---|
| `RELAY_PORT` | port on 127.0.0.1 (8271), behind nginx, which sets `X-Real-IP` and TLS |
| `RELAY_STATE` | the JSON file it keeps everything in, written a moment after each change |
| `RELAY_ORIGINS` | the pages a browser may call it from (https://testnet.cellula.id) |
| `RELAY_NETWORK` | `testnet` (default) or `mainnet`: the address prefix and the chain signatures are read on |

## Keys

Each agent has two, made by the agent and kept in its `phone.json`:

- the secret (64 hex), the agent's alone, kept here as its sha256: it writes the status and what
  waits, and reads the answers;
- the token (32 hex), made from the secret (`phoneToken` in `phone-sign.ts`), in the link the
  person keeps: it reads the agent's page and posts answers.

The first `PUT /v1/agents/<token>` binds the token to the secret, the agent's address, the
approver's address and the return address, and only if the token is made from that secret (403
otherwise): one who has the link cannot claim a token first. A later one with another secret is
refused (401), with another agent, approver or return address too (409). The agent makes a new
token when the person names another wallet. The secret goes as `Authorization: Bearer <secret>`.

## Routes

| route | key | |
| --- | --- | --- |
| `PUT /v1/agents/<token>` | secret | binds, then the agent's status; answers with the ids of the asks it holds |
| `POST /v1/agents/<token>/asks` | secret | a waiting payment and the words to approve or refuse it, open 15 minutes at most |
| `GET /v1/agents/<token>` | token | the agent, the approver, the status, what waits |
| `POST /v1/agents/<token>/answers` | token | words and the wallet's signature; kept only if signed by the approver |
| `GET /v1/agents/<token>/answers?after=` | secret | the answers since a point |
| `GET /health` | | |

An ask's words must start with the lines the agent's own words start with. An answer is checked
with the same `checkSigned` the agent uses (`packages/merchant/src/phone-sign.ts`), so another
wallet's is refused here (403) and costs the agent nothing; one whose check failed (the chain not
read just then) is answered 503 `try_again`. The agent checks each answer again against words it
wrote itself: what the relay says is never taken as is.

Limits: a body of 24 kB (a post-quantum signature is 15,714 hex characters), 20 open asks an agent
(an ask is gone when it ends), its 20 newest answers within 64 kB, 2,000 agents, 10 new agents from
one IPv4 address or IPv6 /48, 48 MB in all, 240 requests a minute from one IPv4 address or IPv6 /64.
When full, an agent not heard from in an hour gives its place. An answer is forgotten after a day,
an agent not heard from in 7 days.

## On a server

Run `dist/relay.mjs` under a service manager, as a user that can write only `RELAY_STATE`'s
folder, behind a reverse proxy with TLS. After an update, `GET /health` says it is up.
