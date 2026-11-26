// An agent's own Fiber balance on testnet, run by the person on the machine their agent runs on:
// a channel opened from the agent's own key, paying invoices and sellers' HTTP 402 answers within
// the caps set here, over an HTTP API on 127.0.0.1 that cellula-mcp (or any program with the key)
// calls. Taking out sends the balance to AGENT_RETURN_TO, the person's address, and nowhere else.
//
//   cellula-agent key       makes the agent's key and the API key in ~/.cellula-agent (never over
//                           one) and says the address to fund
//   cellula-agent --return-to ckt1... --per-payment 1 --total 10
//   optional: --day 2  --approve-above 0.5  --allow api.example.com,02ab...  --open 20  --dir  --port 8280
//
// Each flag stands for an environment variable (config.ts FLAGS), which works too: AGENT_RETURN_TO,
// AGENT_PER_PAYMENT_CKB, AGENT_TOTAL_CKB...; and AGENT_KEY_FILE, AGENT_API_KEY_FILE, HOST and
// AGENT_FETCH_PRIVATE only there. The flags are the one way that reads the same in every shell.
//
// The approvals page's key is made fresh at each start and printed here only, in the sign-in link.
//
// It starts itself again when a channel is renewed (the session exits 75 for that), so it needs no
// service manager; `cellula-agent run` is one run alone.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ccc } from '@ckb-ccc/core'
import { startAgent, openAgent } from '../../../packages/merchant/src/agent-start.ts'
import { serveAgent } from '../../../packages/merchant/src/agent-http.ts'
import { RESERVE_CKB } from '../../../packages/merchant/src/lsp3.ts'
import { Phone } from '../../../packages/merchant/src/agent-phone.ts'
import { phoneToken } from '../../../packages/merchant/src/phone-sign.ts'
import { defaultDir, homePath, readArgs, readConfig, readLocal } from './config.ts'
import { keepPrivate } from './private-dir.ts'

// Set by the build from apps/agent/package.json (scripts/build.mjs).
declare const __AGENT_VERSION__: string
const VERSION = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : 'source'

const HELP = `cellula-agent ${VERSION}: an AI agent's own Fiber balance on the CKB test network

  cellula-agent key        make the agent's key and API key (in ~/.cellula-agent), say the address to fund
  cellula-agent status     what the running agent holds, has spent and has left
  cellula-agent take-out   close its balance and send it to your --return-to address
  cellula-agent            run it; it needs:
      --return-to ckt1...      your testnet address: where a taken-out balance goes
      --per-payment 1          the most one payment can be, in CKB
      --total 10               the most all payments together can be, in CKB
    and can take:
      --day 2                  the most in any 24 hours
      --approve-above 0.5      above this a payment waits for your approval on your approvals page
      --allow a.example,b.example  the sellers' host names (and payees' node keys) it may pay
      --open 20                what its channel holds to spend, 10 to 1,000
      --dir ~/.cellula-agent   where its keys and payments are
      --port 8280              its API's port
      --approver ckt1...       your wallet: approve, refuse, stop and take out from your phone, signed with it

The same in any shell. Each is also an environment variable: AGENT_RETURN_TO, AGENT_PER_PAYMENT_CKB,
AGENT_TOTAL_CKB, AGENT_DAY_CKB, AGENT_APPROVE_ABOVE_CKB, AGENT_ALLOW, AGENT_OPEN_CKB, AGENT_DIR, PORT.
Its API is on http://127.0.0.1:8280 for cellula-mcp; your approvals page's link is printed when it starts.
Test network only: keep on it only what you would not miss. https://testnet.cellula.id/agent`

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

/** The agent's folder, and its key files where they are outside it, readable by the person alone
 * (private-dir.ts). Said, not fatal, if it cannot be done. */
function ownerOnly(dir: string, files: string[]) {
  const inside = (f: string) => path.dirname(path.resolve(f)) === path.resolve(dir)
  for (const t of [dir, ...files.filter((f) => !inside(f) && existsSync(f))]) {
    try {
      keepPrivate(t)
    } catch (e) {
      console.error(`could not keep ${t} to you alone: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RESTART = 75
// Opening again after it could not (not funded yet, no room at the LSP), this often.
const OPEN_AGAIN_MS = 60_000

// The settings on the line go into the environment, over the same ones there, so the runs the
// supervisor starts read them as it does.
const args = (() => {
  try {
    return readArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`cellula-agent: ${e instanceof Error ? e.message : String(e)}\n\n${HELP}`)
    process.exit(1)
  }
})()
Object.assign(process.env, args.env)
const sub = args.command
if (sub === 'help') {
  console.log(HELP)
  process.exit(0)
}
if (sub === 'version') {
  console.log(VERSION)
  process.exit(0)
}
if (sub !== undefined && !['key', 'run', 'status', 'take-out'].includes(sub)) {
  console.error(`cellula-agent: no command ${sub}\n\n${HELP}`)
  process.exit(1)
}
if (sub === 'key') {
  // Never over a key already there: it may hold a balance.
  const env = process.env
  const dir = env.AGENT_DIR ? homePath(env.AGENT_DIR) : defaultDir()
  const keyFile = env.AGENT_KEY_FILE ? homePath(env.AGENT_KEY_FILE) : path.join(dir, 'key')
  const apiKeyFile = env.AGENT_API_KEY_FILE ? homePath(env.AGENT_API_KEY_FILE) : path.join(dir, 'api.key')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Private before the keys are written, so they are born that way on Windows too.
  ownerOnly(dir, [])
  const made: string[] = []
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, `0x${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
    made.push(`the agent's key: ${keyFile}`)
  }
  if (!existsSync(apiKeyFile)) {
    writeFileSync(apiKeyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
    made.push(`the API key, for cellula-mcp: ${apiKeyFile}`)
  }
  ownerOnly(dir, [keyFile, apiKeyFile])
  const key = readFileSync(keyFile, 'utf8').trim()
  const address = await new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), key.startsWith('0x') ? key : `0x${key}`).getRecommendedAddress()
  console.log(made.length ? `made ${made.join('\nmade ')}` : `the keys are there already: ${keyFile}, ${apiKeyFile}`)
  console.log(`\nthe agent's testnet address: ${address}`)
  console.log("fund it with testnet CKB (https://faucet.nervos.org): 700 for its first channel of 20 CKB, the LSP's opening fee if it asks one, and the change")
  console.log('\nthen start it with your own testnet address and your limits:')
  console.log('  npx cellula-agent --return-to ckt1... --per-payment 1 --total 10')
  process.exit(0)
}

if (sub === 'status' || sub === 'take-out') {
  // Beside the running agent, through its API: the same in every shell, with no curl to write.
  const fail = (m: string) => {
    console.error(`cellula-agent ${sub}: ${m}`)
    process.exit(1)
  }
  let local: { base: string; apiKey: string } = { base: '', apiKey: '' }
  try {
    local = readLocal(process.env, (f) => readFileSync(f, 'utf8'))
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
  const call = async (method: 'GET' | 'POST', route: string) => {
    let r: Response
    try {
      r = await fetch(local.base + route, { method, headers: { authorization: `Bearer ${local.apiKey}` } })
    } catch {
      return fail(`the agent does not answer at ${local.base}: start it first`)
    }
    const body = (await r.json().catch(() => null)) as { error?: { message?: string } } & Record<string, any>
    if (!r.ok) return fail(body?.error?.message ?? `the agent answered ${r.status}`)
    return body
  }
  const st = await call('GET', '/v1/status')
  if (sub === 'status') {
    const c = st.caps
    console.log(`${st.ready ? 'ready' : 'not ready'}: holds ${st.balance_ckb} CKB, spent ${st.spent_ckb} CKB`)
    console.log(`limits: ${c.per_payment_ckb ?? 'any'} CKB a payment${c.total_ckb ? `, ${c.left_ckb} of ${c.total_ckb} CKB left in all` : ''}${c.day_ckb ? `, ${c.day_left_ckb} of ${c.day_ckb} CKB left in 24 hours` : ''}`)
    if (st.approve_above_ckb) console.log(`above ${st.approve_above_ckb} CKB a payment waits for you${st.waiting_approvals ? `: ${st.waiting_approvals} waiting` : ''}`)
    if (st.paused) console.log('every payment is stopped')
    if (st.take_out) console.log(`take-out: ${st.take_out.status}${st.take_out.tx ? `, ${st.take_out.tx}` : ''}${st.take_out.error ? `, ${st.take_out.error}` : ''}`)
    console.log(`its address, to top it up: ${st.address}`)
    process.exit(0)
  }
  if (!st.return_to) fail('it was started without --return-to, so the balance would stay at its own address')
  const asked = await call('POST', '/v1/take-out')
  console.log(
    asked.status === 'waiting'
      ? `a payment is on its way: once it ends the agent closes its channel and sends the balance to ${st.return_to}, and starts no payment meanwhile`
      : `closing its channel with the LSP, then sending the balance to ${st.return_to}`,
  )
  // The close takes about a minute, the transaction to the person a few seconds more. A payment on
  // its way can take longer: the agent carries the take-out on by itself, so this only watches.
  let t: { status: string; to?: string; tx?: string; error?: string } | null = null
  for (const until = Date.now() + 12 * 60_000; Date.now() < until; await sleep(3_000)) {
    t = (await call('GET', '/v1/status')).take_out
    if (t?.status === 'returned') {
      console.log(`sent to ${t.to}: ${t.tx}`)
      process.exit(0)
    }
    if (t?.status === 'failed') fail(t.error ?? 'the take-out did not finish')
  }
  console.log(`still ${t?.status ?? 'closing'} after 12 minutes; the agent carries it on by itself, and cellula-agent status says where it stands`)
  process.exit(0)
}

// Made once for the supervisor and its runs, so a run started again for a new channel keeps the
// browser signed in. Never written to a file.
process.env.AGENT_APPROVAL_KEY ||= randomBytes(24).toString('hex')

if (sub !== 'run') {
  // The supervisor: one run at a time, started again when it asks to (exit 75).
  const self = fileURLToPath(import.meta.url)
  for (;;) {
    const code = await new Promise<number>((resolve) => spawn(process.execPath, [self, 'run'], { stdio: 'inherit' }).on('exit', (c) => resolve(c ?? 1)))
    if (code !== RESTART) process.exit(code)
    log('starting again for a new channel')
  }
}

// A setting missing or refused: said in one line, not as a stack.
const cfg = (() => {
  try {
    return readConfig(process.env, (f) => readFileSync(f, 'utf8'))
  } catch (e) {
    console.error(`the agent did not start: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
})()
if (!existsSync(cfg.keyFile)) {
  console.error(`the agent did not start: no key at ${cfg.keyFile}: run cellula-agent key first`)
  process.exit(1)
}
// Its folder holds the channel's state beside the keys: kept to the person at every start, a
// folder made or loosened since included.
mkdirSync(cfg.dir, { recursive: true, mode: 0o700 })
ownerOnly(cfg.dir, [cfg.keyFile])
const base =`http://${cfg.host === '::1' ? '[::1]' : cfg.host}:${cfg.port}`
// The phone (agent-phone.ts), when the person named their wallet: the secret the agent writes to the
// relay with, and the token in the link they keep, made from it (phoneToken), kept in its own folder.
const phoneFile = path.join(cfg.dir, 'phone.json')
const phoneKeys = (() => {
  if (!cfg.approver) return null
  let kept: Record<string, unknown> = {}
  try {
    kept = JSON.parse(readFileSync(phoneFile, 'utf8'))
  } catch {}
  // A new link for another wallet (the relay keeps a link's approver as its first write named it),
  // and for a token not made from its secret (an older link's, which a relay now refuses).
  if (!/^[0-9a-f]{64}$/.test(String(kept.secret)) || kept.token !== phoneToken(String(kept.secret)) || kept.approver !== cfg.approver) {
    const secret = randomBytes(32).toString('hex')
    kept = { token: phoneToken(secret), secret, approver: cfg.approver }
    writeFileSync(phoneFile, JSON.stringify(kept), { mode: 0o600 })
  }
  return { token: String(kept.token), secret: String(kept.secret) }
})()
const started = await startAgent({
  dir: cfg.dir,
  key: readFileSync(cfg.keyFile, 'utf8').trim(),
  openCkb: cfg.openCkb,
  caps: { per_payment_ckb: cfg.perPaymentCkb, total_ckb: cfg.totalCkb, ...(cfg.dayCkb ? { day_ckb: cfg.dayCkb } : {}) },
  returnTo: cfg.returnTo,
  allow: cfg.allow ?? undefined,
  approveAboveCkb: cfg.approveAboveCkb ?? undefined,
  approvalsUrl: `${base}/approvals`,
  phone: !!phoneKeys,
  gateway: cfg.gateway,
  log,
}).catch((e) => {
  console.error(`the agent did not start: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
await serveAgent(started.agent, { port: cfg.port, host: cfg.host, apiKey: cfg.apiKey, address: started.address, fetchPrivate: cfg.fetchPrivate, approvalKey: cfg.approvalKey, log })
log(`agent API on ${base}; its address ${started.address}; money goes back to ${cfg.returnTo}`)
// Each limit said, and each one left off said too, so nothing is off without the person reading it.
log(`caps: ${cfg.perPaymentCkb} CKB a payment, ${cfg.totalCkb} CKB in all, ${cfg.dayCkb ? `${cfg.dayCkb} CKB in any 24 hours` : 'no 24-hour cap (--day)'}`)
log(cfg.approveAboveCkb ? `a payment above ${cfg.approveAboveCkb} CKB waits for your approval` : 'no payment waits for your approval (--approve-above)')
log(cfg.allow ? `pays only: ${cfg.allow.join(', ')}` : 'pays any seller (--allow names the ones it may pay)')
log(`your approvals page (keep this link to yourself, it is the page's key): ${base}/approvals/sign-in?key=${cfg.approvalKey}`)
if (phoneKeys && cfg.approver) {
  const phone = new Phone({ agent: started.agent, relay: cfg.relay, page: cfg.phonePage, token: phoneKeys.token, secret: phoneKeys.secret, address: started.address, approver: cfg.approver, returnTo: cfg.returnTo, client: started.wallet.client, file: phoneFile, log })
  phone.start()
  log(`your phone page (keep it on your phone; it shows the agent, and only your wallet ${cfg.approver.slice(0, 12)}...${cfg.approver.slice(-6)} can act there): ${phone.url()}`)
} else log('no phone page (--approver names your wallet for one)')
if (cfg.fetchPrivate) log('AGENT_FETCH_PRIVATE=1: fetch reaches this machine and its network too, for testing a seller here')

// Taken out already: a new channel once its address holds enough for one (openAgent starts over for
// it). It idled here for good before, so a folder taken out once could never pay again, whatever
// its address held (2026-11-01).
if (started.agent.status().take_out && started.session.state.channel?.closed) {
  const need = BigInt(cfg.openCkb + RESERVE_CKB + 62) * 100_000_000n
  const held = async () => started.wallet.getBalance().catch(() => 0n)
  if ((await held()) < need) {
    log(`the balance was taken out; with ${cfg.openCkb + RESERVE_CKB + 62} CKB at ${started.address} it opens a new channel (the LSP's opening fee is paid once per address)`)
    while ((await held()) < need) await sleep(OPEN_AGAIN_MS)
  }
  log('CKB at its address again: opening a new channel')
}
for (;;) {
  try {
    await openAgent(started, { openCkb: cfg.openCkb, log })
    break
  } catch (e) {
    log(`not open yet: ${e instanceof Error ? e.message : String(e)}`)
    log(`it needs ${cfg.openCkb} CKB plus the ${RESERVE_CKB} CKB reserve at ${started.address}, and the LSP's opening fee if it asks one; trying again in a minute`)
    await sleep(OPEN_AGAIN_MS)
  }
}
