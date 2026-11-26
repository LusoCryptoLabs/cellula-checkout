// The agent's side of the person's phone (apps/agent-relay, 2026-11-01): what waits for the person
// goes to the relay, with the words their wallet will sign; what they signed comes back and is
// checked here, against the words written here and the person's address fixed at start, before
// anything is done. The relay is trusted with nothing: an answer it invents, alters or replays is
// refused here. What it sends is bounded (a reply's size, the answers looked at in a round), and
// which answers were seen is kept here, not counted by the relay, so a relay that forgets, starts
// again or lies about its count cannot make the agent miss what the person signs next.

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ccc } from '@ckb-ccc/core'
import type { Agent } from './agent.ts'
import { agentMark, askMessages, checkSigned, readCommand, type WalletSignature } from './phone-sign.ts'

export type PhoneOptions = {
  agent: Agent
  /** The relay's address, as https://agent-relay.lusocryptolabs.com. */
  relay: string
  /** The link the person keeps, before `#phone=<token>`. */
  page: string
  token: string
  secret: string
  /** The agent's own address: the words name it, so a signature for one agent moves no other. */
  address: string
  /** The person's wallet address: only its signatures count. */
  approver: string
  returnTo: string | null
  client: ccc.Client
  /** Where the token, the secret, the answers seen and the commands' nonces are kept. */
  file: string
  fetch?: typeof fetch
  everyMs?: number
  statusMs?: number
  now?: () => number
  log?: (line: string) => void
}

type Kept = { seen: Record<string, number>; used: Record<string, number> }
type RelayAnswer = { message: string; signature: WalletSignature }

/** The most a relay's reply can be, and the answers one round looks at, and signature checks. */
const REPLY_MOST = 256 * 1024
const ANSWERS_A_ROUND = 50
const CHECKS_A_ROUND = 10
/** An answer seen, or a nonce used, is kept this long: the relay keeps an answer a day, and a command is good 10 minutes. */
const KEPT_MS = 2 * 24 * 3600_000
/** And at most this many answers seen: one forgotten is only checked again, and does nothing twice. */
const SEEN_MOST = 1000
/** An answer whose check failed (the chain not read just then) is checked again this long. */
const UNSURE_MS = 15 * 60_000

export class Phone {
  private kept: Kept
  private changed = false
  private posted = new Set<string>()
  private unsure = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private lastStatus = 0
  private registered = false
  private quietUntil = 0
  private running: Promise<void> | null = null
  private o: PhoneOptions

  constructor(o: PhoneOptions) {
    this.o = o
    let k: Partial<Kept> = {}
    try {
      k = JSON.parse(readFileSync(o.file, 'utf8')).phone ?? {}
    } catch {}
    const map = (x: unknown) => (x && typeof x === 'object' ? (x as Record<string, number>) : {})
    this.kept = { seen: map(k.seen), used: map(k.used) }
  }

  /** The link the person keeps on their phone, with this agent's mark: the page signs for it only. */
  url(): string {
    return `${this.o.page}#phone=${this.o.token}.${agentMark(this.o.address)}`
  }

  start(): void {
    const every = this.o.everyMs ?? 3000
    const turn = () => {
      this.running = this.round().finally(() => {
        this.running = null
        if (this.timer) this.timer = setTimeout(turn, every)
      })
    }
    this.timer = setTimeout(turn, 0)
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.running
  }

  /** One round: the status now and then, what newly waits, then what the person signed. */
  async round(): Promise<void> {
    const now = this.now()
    try {
      if (!this.registered || now - this.lastStatus >= (this.o.statusMs ?? 20_000)) {
        const put = (await this.call('PUT', '', { agent: this.o.address, approver: this.o.approver, return_to: this.o.returnTo, status: this.status() })) as { asks?: unknown }
        // What the relay still holds: one it forgot (a restart, a lost file) is posted again.
        if (Array.isArray(put?.asks)) this.posted = new Set([...this.posted].filter((id) => (put.asks as unknown[]).includes(id)))
        this.registered = true
        this.lastStatus = now
      }
      for (const a of this.o.agent.approvals()) {
        if (a.status !== 'waiting' || this.posted.has(a.id)) continue
        await this.call('POST', '/asks', { id: a.id, messages: askMessages(this.o.address, a), details: { amount_ckb: a.amount_ckb, seller: a.seller, payee: a.payee, memo: a.memo }, expires_at: a.expires_at })
        this.posted.add(a.id)
        this.lastStatus = 0
      }
      const got = (await this.call('GET', '/answers')) as { answers?: unknown }
      const answers = Array.isArray(got?.answers) ? (got.answers as RelayAnswer[]).slice(-ANSWERS_A_ROUND) : []
      let checks = 0
      for (const answer of answers) {
        if (typeof answer?.message !== 'string' || !answer.signature) continue
        const key = createHash('sha256').update(`${answer.message}\n${String(answer.signature.signature)}`).digest('hex').slice(0, 32)
        if (this.kept.seen[key]) continue
        if (checks >= CHECKS_A_ROUND) break
        // Kept once its signature was checked; words that match nothing cost nothing to read again.
        // One whose check failed (not a bad signature: the chain not read) is checked again, so the
        // person's answer is not lost to a moment's outage.
        const end = await this.handle(answer)
        if (end === 'ignored') continue
        checks++
        const first = this.unsure.get(key) ?? this.now()
        if (end === 'later' && this.now() - first < UNSURE_MS) {
          this.unsure.set(key, first)
          continue
        }
        if (end === 'later') this.o.log?.("phone: an answer whose signature could not be checked for 15 minutes, set aside")
        this.unsure.delete(key)
        this.kept.seen[key] = this.now()
        this.changed = true
      }
    } catch (e) {
      // Said once a minute at most: the relay may be away, and the agent goes on without it.
      if (now > this.quietUntil) {
        this.o.log?.(`phone: the relay did not answer (${e instanceof Error ? e.message : String(e)}); the approvals page on this computer still works`)
        this.quietUntil = now + 60_000
      }
    } finally {
      this.save()
    }
  }

  /** An answer the relay passed on, checked here before it does anything: 'ignored' (words of
   * nothing here, no signature checked), 'done', or 'later' (its check failed: checked again). */
  private async handle(answer: RelayAnswer): Promise<'ignored' | 'done' | 'later'> {
    const message = answer.message
    const waiting = this.o.agent.approvals().filter((a) => a.status === 'waiting')
    for (const a of waiting) {
      const words = askMessages(this.o.address, a)
      if (message !== words.approve && message !== words.refuse) continue
      const signed = await this.signed(message, answer.signature)
      if (signed !== 'yes') return signed === 'unsure' ? 'later' : 'done'
      try {
        this.o.agent.decide(a.id, message === words.approve)
      } catch {}
      this.lastStatus = 0
      return 'done'
    }
    const cmd = readCommand(this.o.address, this.o.returnTo, message, this.now())
    if (!cmd || this.kept.used[cmd.nonce]) return 'ignored'
    const signed = await this.signed(message, answer.signature)
    if (signed !== 'yes') return signed === 'unsure' ? 'later' : 'done'
    this.kept.used[cmd.nonce] = cmd.atMs
    this.changed = true
    this.o.log?.(`phone: ${cmd.command}, signed by the person's wallet`)
    if (cmd.command === 'take-out') await this.o.agent.takeOut().catch((e) => this.o.log?.(`phone: take-out not started: ${e instanceof Error ? e.message : String(e)}`))
    // A stop always stops. A go-again undoes the stop it names, and only while that stop is the one
    // in force: one held back past a later stop (on either page) undoes nothing.
    else if (cmd.command === 'stop') await this.o.agent.pause(true)
    else if (this.o.agent.status().paused_id === cmd.stop) await this.o.agent.pause(false)
    else this.o.log?.('phone: that go-again names a stop no longer in force, so it changes nothing')
    this.lastStatus = 0
    return 'done'
  }

  private async signed(message: string, sig: WalletSignature): Promise<'yes' | 'no' | 'unsure'> {
    const said = await checkSigned(this.o.client, message, sig, this.o.approver)
    if (said === 'no') this.o.log?.('phone: an answer not signed by the wallet the agent was started with, ignored')
    if (said === 'unsure') this.o.log?.("phone: an answer's signature could not be checked just now; checked again shortly")
    return said
  }

  private status() {
    const s = this.o.agent.status()
    return {
      ready: s.ready,
      balance_ckb: s.balance_ckb,
      spent_ckb: s.spent_ckb,
      caps: s.caps,
      approve_above_ckb: s.approve_above_ckb,
      paused: s.paused,
      paused_id: s.paused_id,
      waiting_approvals: s.waiting_approvals,
      take_out: s.take_out ? { status: s.take_out.status, tx: s.take_out.tx } : null,
    }
  }

  private async call(method: string, route: string, body?: unknown): Promise<unknown> {
    const f = this.o.fetch ?? fetch
    const r = await f(`${this.o.relay}/v1/agents/${this.o.token}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.o.secret}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    const text = await readSome(r, REPLY_MOST)
    let json: { error?: { message?: string } } | null = null
    try {
      json = JSON.parse(text)
    } catch {}
    if (!r.ok) throw new Error(json?.error?.message ?? `the relay answered ${r.status}`)
    return json
  }

  /** Written whole, once a round and only when something changed, through a file beside it. */
  private save() {
    if (!this.changed) return
    const t = this.now()
    for (const m of [this.kept.seen, this.kept.used]) for (const [k, at] of Object.entries(m)) if (!(t - at < KEPT_MS)) delete m[k]
    const seen = Object.entries(this.kept.seen)
    if (seen.length > SEEN_MOST) this.kept.seen = Object.fromEntries(seen.sort((a, b) => b[1] - a[1]).slice(0, SEEN_MOST))
    const tmp = `${this.o.file}.new`
    writeFileSync(tmp, JSON.stringify({ token: this.o.token, secret: this.o.secret, approver: this.o.approver, phone: this.kept }), { mode: 0o600 })
    renameSync(tmp, this.o.file)
    this.changed = false
  }

  private now() {
    return (this.o.now ?? Date.now)()
  }
}

/** A reply's body, refused past `most` bytes. */
async function readSome(r: Response, most: number): Promise<string> {
  if (!r.body) return ''
  const reader = r.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > most) {
      await reader.cancel().catch(() => {})
      throw new Error(`the relay's reply is over ${most} bytes`)
    }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}
