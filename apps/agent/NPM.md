# cellula-agent

Your AI agent's own Fiber balance, on the CKB test network. It pays APIs that answer HTTP 402
(x402) by itself, within limits you set, and waits for your approval above an amount you choose.
Claude and other MCP clients drive it through [cellula-mcp](https://www.npmjs.com/package/cellula-mcp).

**Test network only.** Its key file is its balance: keep on it only what you would not miss.

## Start

Node 20 or later, on Windows, macOS or Linux. Each command is one line, the same in PowerShell,
cmd, bash or zsh.

1. Make its keys. This writes them to `.cellula-agent` in your home folder and prints the address
   to fund:

   ```sh
   npx cellula-agent key
   ```

2. Fund that address with testnet CKB from the [faucet](https://faucet.nervos.org). 700 CKB
   covers its first channel of 20 CKB, with the LSP's opening fee of 500 CKB (it opens no channel
   if the LSP asks more), paid once per
   wallet, and the change it needs (680 is just short).

3. Start it, with your own testnet address and your limits, and leave it running:

   ```sh
   npx cellula-agent --return-to ckt1...your-address --per-payment 1 --total 10 --day 2 --approve-above 0.5
   ```

   It opens its channel (about a minute), then prints a link to your approvals page. Add
   `--approver ckt1...your-cellula-wallet` to approve from your phone too (see below).

4. In another terminal, connect Claude Code to it:

   ```sh
   claude mcp add cellula npx cellula-mcp@0.4.1 -e CELLULA_NETWORK=testnet
   ```

   cellula-mcp finds the agent's API key in `.cellula-agent` by itself. With its version named,
   npx starts it in a couple of seconds; without, it asks the registry each time, which took 15 to
   19 s here, near Claude Code's 30 s limit for a server to start.

   Then ask it, for example: *Get the report for alice.cell from
   https://fiber-names-api.lusocryptolabs.com/v1/names/alice.cell, at most 0.2 CKB.*

### Other MCP clients

A client that takes a JSON config takes this:

```json
{ "mcpServers": { "cellula": { "command": "npx", "args": ["-y", "cellula-mcp@0.4.1"], "env": { "CELLULA_NETWORK": "testnet" } } } }
```

Tested with Claude Code and with mcphost driving a local model (qwen2.5 14B on Ollama): both
paid, and both were refused past a limit and said why.

## When you are done

```sh
npx cellula-agent status
npx cellula-agent take-out
```

`status` says what it holds, has spent and has left. `take-out` closes its balance and sends it to
your `--return-to` address, about two minutes. With a payment on its way, it starts no other and
takes out as soon as that one ends. If the LSP closed the channel itself, `take-out` sends on what
came back to the agent's address. Your approvals page has the same button.

To use it again after a take-out, put CKB at its address and start it as before: it opens a new
channel once the address holds 181 CKB (the LSP's opening fee is paid once per address).

## Your limits

Set when you start it. Nothing your agent is told can change them.

| setting | |
| --- | --- |
| `--return-to` | required: your testnet address. A taken-out balance goes there and nowhere else |
| `--per-payment` | required: the most one payment can be, in CKB |
| `--total` | required: the most all payments together can be, in CKB |
| `--day` | the most in any 24 hours |
| `--approve-above` | above this, a payment waits for you on your approvals page |
| `--approver` | your Cellula wallet's testnet address: approve, refuse, stop and take out from your phone, signed by it |
| `--allow` | the sellers' host names (and payees' node keys) it may pay, separated by commas |
| `--open` | what its channel holds to spend, 10 to 1,000 (20) |
| `--dir` | where its keys and payments are (`.cellula-agent` in your home folder) |
| `--port` | its API's port (8280); cellula-mcp then needs `-e CELLULA_AGENT_URL=http://127.0.0.1:<port>` |

Each can also be set in the environment: `AGENT_RETURN_TO`, `AGENT_PER_PAYMENT_CKB`,
`AGENT_TOTAL_CKB`, `AGENT_DAY_CKB`, `AGENT_APPROVE_ABOVE_CKB`, `AGENT_APPROVER`, `AGENT_ALLOW`,
`AGENT_OPEN_CKB`, `AGENT_DIR`, `PORT`. One given on the line wins.

It also never fetches an address on your computer or your network, and its API listens on your
computer only.

The limits count what sellers ask. Fiber's routing fee comes on top: 0.5% on the test network's
LSP on 2026-11-01, and never more than 1% plus 0.01 CKB a payment, which its signer refuses.

Start it in your own terminal, not through your AI agent: the link to your approvals page is
printed there. And an AI agent that can read files or run commands on your computer can read
`.cellula-agent`, which holds its key: give it the cellula tools, not those.

## Your approvals page

Open the link it prints when it starts (the key in it is made fresh each time). There you see a
payment waiting for you, with the seller, what is bought and the amount, and approve or refuse it.
"Stop every payment" stops them all until you let it pay again, a restart included. "Take it all
out" sends its balance to your address, once you tick the box. It also shows what was paid and what
was refused lately. Your agent cannot open this page: its key does not work there.

## On your phone

Started with `--approver`, it also prints a link to `testnet.cellula.id/agent#phone=...`. Keep it
on your phone. It shows the agent's balance and what waits, with the same buttons: Approve,
Refuse, Stop every payment, Let it pay again, and Take it all out. Each opens your Cellula wallet,
which shows the words you sign (the amount, the seller, what for) and signs them with your passkey.

The agent acts only on words it wrote itself, signed by the wallet you named when you started it.
It checks each signature on your computer, so the relay that carries them cannot approve, stop or
take out anything for you: the most it can do is hold your answer back, or show your page a wrong
balance. The page shows each payment from the words your wallet signs, not from what the relay says
beside them. A take-out still goes to `--return-to` only. A stop always stops. A go-again names the
stop it undoes, so one held back past a later stop does nothing. Each is good for 10 minutes and
once. The link names the agent it is for: if the relay shows another, the page signs nothing.

The link is kept in `.cellula-agent` and stays the same across restarts; naming another wallet
makes a new one. Anyone with the link sees what the page shows; only your wallet can act there.
Your AI agent is not given the link.

What goes through the relay (`agent-relay.lusocryptolabs.com`, ours): the agent's and your
wallet's addresses, the return address, its balance, spent and limits, and each waiting payment's
amount, seller and what it is for, with your signed answers. It forgets an answer after a day and
an agent not heard from in 7 days. Without `--approver`, nothing is sent there.

## Its API

On `http://127.0.0.1:8280`, with `Authorization: Bearer <the API key>`:

| route | |
| --- | --- |
| `GET /v1/status` | balance, spent, limits and what is left |
| `POST /v1/fetch` `{url, max_ckb, method?, headers?, body?}` | calls a URL, pays its 402 once, asks again with the receipt; a seller is paid over HTTPS only, and `headers` cannot change where the request goes (no `Host`) |
| `POST /v1/pay` `{invoice, max_ckb?, memo?}` | pays a Fiber invoice that names its amount |
| `GET /v1/payments` | the payments and their receipts |
| `POST /v1/take-out` | closes the channel and sends the balance to your `--return-to` address |

`cellula-agent --help` lists the commands and settings. More: [testnet.cellula.id/agent](https://testnet.cellula.id/agent).

MIT licence.
