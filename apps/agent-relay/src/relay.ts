// The relay between a Cellula agent on a person's computer and that person's phone (2026-11-01).
// The agent cannot be reached from outside (its API listens on 127.0.0.1), so it leaves here what
// waits for the person, and reads back what they signed. The relay holds no key and decides
// nothing: it keeps an answer only when the wallet the agent named signed it, and the agent checks
// every answer again itself, against words it wrote; the page shows the person what the words say.
// A relay that lies can lose, withhold or delay a message, or show the page a wrong status; the
// agent's own approvals page still works then.
//
//   PUT  /v1/agents/<token>          the agent, with its secret: who it is, whose wallet answers, its status
//   POST /v1/agents/<token>/asks     the agent, with its secret: a payment waiting, with the words to sign
//   GET  /v1/agents/<token>          the person's page: the status and what waits
//   POST /v1/agents/<token>/answers  the person's page: words and the wallet's signature
//   GET  /v1/agents/<token>/answers  the agent, with its secret: what the person signed (since `after`)
//
// The token is in the link the person keeps (it lets one read the status, not act); the secret
// never leaves the agent, which proves it with each write.

import type http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ccc } from '@ckb-ccc/core'
import { checkSigned, phoneToken, readCommand, type WalletSignature } from '../../../packages/merchant/src/phone-sign.ts'

export type Ask = { id: string; messages: { approve: string; refuse: string }; details: Record<string, unknown>; expires_at: number }
export type Answer = { seq: number; kind: 'approve' | 'refuse' | 'command'; ask_id: string | null; message: string; signature: WalletSignature; at: number }
export type AgentEntry = {
  secret_hash: string
  agent: string
  approver: string
  return_to: string | null
  status: Record<string, unknown> | null
  updated_at: number
  asks: Ask[]
  answers: Answer[]
  seq: number
}
export type RelayState = { agents: Record<string, AgentEntry> }

export type RelayOptions = {
  state: RelayState
  /** Called after each change, to keep the state on disk. */
  save?: () => void
  client: ccc.Client
  /** The pages that may read and answer from a browser (CORS). */
  origins: string[]
  /** Addresses of this network: `ckt1` on testnet. */
  addressPrefix: string
  now?: () => number
  log?: (line: string) => void
}

const TOKEN = /^[0-9a-f]{32}$/
const SECRET = /^[0-9a-f]{64}$/
const ASK_ID = /^[0-9a-f]{12}$/
/** A post-quantum wallet's signature is 15,714 hex characters: an answer carrying one fits. */
const BODY_MOST = 24 * 1024
const SIGNATURE_MOST = 16_500
const OPEN_ASKS = 20
const ANSWERS_KEPT = 20
const ANSWER_BYTES_KEPT = 64 * 1024
const AGENTS_MOST = 2_000
/** New agents from one IPv4 address or IPv6 /48, kept at once. */
const AGENTS_A_PLACE = 10
/** All agents together, as JSON: well inside the service's 256 MB. */
const STATE_MOST = 48 * 1024 * 1024
/** When full, an agent not heard from in this long gives its place (a running one writes every 20 s). */
const IDLE_MS = 3600_000
const ASK_LONGEST_MS = 15 * 60_000
const AGENT_FORGOTTEN_MS = 7 * 24 * 3600_000
const ANSWER_KEPT_MS = 24 * 3600_000
const PER_MINUTE = 240

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Where a request comes from, for limits: an IPv4 address as is, an IPv6 one by its first `groups`
 * groups (4: its /64, one network; 3: its /48, one site), since one network holds many addresses. */
export function placeOf(ip: string, groups: number): string {
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (v4) return v4[1]!
  if (!ip.includes(':')) return ip
  const [head = '', tail = ''] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const all = ip.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  return `${all.slice(0, groups).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/${groups * 16}`
}

/** The newest answers, as many as fit: always the newest one. */
const keepAnswers = (answers: Answer[]) => {
  const kept: Answer[] = []
  let bytes = 0
  for (const a of [...answers].reverse()) {
    bytes += a.message.length + a.signature.signature.length + a.signature.identity.length + 100
    if (kept.length && (kept.length >= ANSWERS_KEPT || bytes > ANSWER_BYTES_KEPT)) break
    kept.unshift(a)
  }
  return kept
}

export function relayHandler(o: RelayOptions) {
  const now = o.now ?? Date.now
  const address = new RegExp(`^${o.addressPrefix}1[0-9a-z]{40,200}$`)
  const seen = new Map<string, { at: number; n: number }>()
  // Each agent's size as JSON, and the place that made it (since this start), for the limits above.
  const sizes = new Map<string, number>()
  const places = new Map<string, string>()
  const measure = (token: string) => {
    const e = o.state.agents[token]
    if (e) sizes.set(token, JSON.stringify(e).length)
    else sizes.delete(token), places.delete(token)
  }
  const total = () => {
    let n = 0
    for (const v of sizes.values()) n += v
    return n
  }
  const forget = (token: string) => {
    delete o.state.agents[token]
    measure(token)
  }
  for (const token of Object.keys(o.state.agents)) measure(token)

  const prune = () => {
    const t = now()
    for (const [token, e] of Object.entries(o.state.agents)) {
      if (t - e.updated_at > AGENT_FORGOTTEN_MS) {
        forget(token)
        continue
      }
      const asks = e.asks.filter((a) => a.expires_at > t)
      const answers = keepAnswers(e.answers.filter((a) => t - a.at < ANSWER_KEPT_MS))
      if (asks.length === e.asks.length && answers.length === e.answers.length) continue
      e.asks = asks
      e.answers = answers
      measure(token)
    }
  }

  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = String(req.headers.origin ?? '')
    const cors: Record<string, string> = o.origins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors })
      res.end(JSON.stringify(body))
    }
    const fail = (status: number, code: string, message: string) => send(status, { error: { code, message } })
    const url = new URL(req.url ?? '/', 'http://relay')

    // One client, this many asks a minute, by the address nginx saw (X-Real-IP, which it sets itself;
    // X-Forwarded-For carries whatever the client wrote first).
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '').trim()
    const who = placeOf(ip, 4)
    const t = now()
    const count = seen.get(who)
    if (!count || t - count.at > 60_000) seen.set(who, { at: t, n: 1 })
    else if (++count.n > PER_MINUTE) return fail(429, 'too_many', 'too many requests: wait a minute')
    if (seen.size > 50_000) seen.clear()

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' })
      return res.end()
    }
    if (url.pathname === '/health') return send(200, { ok: true })
    const m = url.pathname.match(/^\/v1\/agents\/([^/]+)(\/asks|\/answers)?$/)
    if (!m) return fail(404, 'not_found', 'no such route')
    const token = m[1]!
    if (!TOKEN.test(token)) return fail(400, 'invalid_request', 'the token is 32 hex characters')
    const route = `${req.method} ${m[2] ?? ''}`
    prune()
    const entry = o.state.agents[token]

    // The agent's own writes and reads, proved by its secret.
    const agentOnly = () => {
      const secret = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!SECRET.test(secret)) return 'no'
      if (entry && !same(entry.secret_hash, hash(secret))) return 'no'
      return secret
    }

    const body = (then: (b: any) => void | Promise<void>) => {
      let raw = ''
      let over = false
      req.setEncoding('utf8')
      req.on('data', (c: string) => {
        if (over) return
        raw += c
        if (raw.length > BODY_MOST) {
          over = true
          fail(413, 'too_large', 'that body is too large')
        }
      })
      req.on('end', () => {
        if (over) return
        let b: unknown
        try {
          b = JSON.parse(raw || 'null')
        } catch {
          return fail(400, 'invalid_request', 'the body must be JSON')
        }
        Promise.resolve(then(b)).catch((e) => {
          o.log?.(`relay: ${e instanceof Error ? e.message : String(e)}`)
          fail(500, 'internal', 'something failed here')
        })
      })
    }

    if (route === 'PUT ') {
      const secret = agentOnly()
      if (secret === 'no') return fail(401, 'unauthorized', 'the agent proves itself with its secret')
      return body((b) => {
        if (!b || typeof b !== 'object') return fail(400, 'invalid_request', 'a JSON object')
        const status = b.status ?? null
        if (status !== null && (typeof status !== 'object' || JSON.stringify(status).length > 2048)) return fail(400, 'invalid_request', 'status is a small object')
        if (!entry) {
          // A token is made from its agent's secret (phoneToken), so one who has only the link, the
          // person or anyone they showed it to, cannot take a token the relay does not hold yet.
          if (phoneToken(secret) !== token) return fail(403, 'not_yours', "a new agent's token is made from its secret")
          if (!address.test(String(b.agent)) || !address.test(String(b.approver)) || (b.return_to != null && !address.test(String(b.return_to))))
            return fail(400, 'invalid_request', `agent, approver and return_to are ${o.addressPrefix}1 addresses`)
          const place = placeOf(ip, 3)
          if ([...places.values()].filter((p) => p === place).length >= AGENTS_A_PLACE) return fail(429, 'too_many', 'too many agents from one network')
          if (Object.keys(o.state.agents).length >= AGENTS_MOST) {
            const idle = Object.entries(o.state.agents).sort((x, y) => x[1].updated_at - y[1].updated_at)[0]
            if (!idle || now() - idle[1].updated_at < IDLE_MS) return fail(503, 'full', 'no room for another agent now')
            forget(idle[0])
          }
          if (total() > STATE_MOST) return fail(503, 'full', 'no room for another agent now')
          o.state.agents[token] = { secret_hash: hash(secret), agent: b.agent, approver: b.approver, return_to: b.return_to ?? null, status, updated_at: now(), asks: [], answers: [], seq: 0 }
          places.set(token, place)
        } else {
          // Who the agent is and whose wallet answers are fixed by its first write.
          if (b.agent !== entry.agent || b.approver !== entry.approver || (b.return_to ?? null) !== entry.return_to) return fail(409, 'conflict', 'this token belongs to another agent or approver')
          entry.status = status
          entry.updated_at = now()
        }
        measure(token)
        o.save?.()
        // The asks held, so an agent posts again what a relay forgot.
        send(200, { ok: true, asks: o.state.agents[token]!.asks.map((a) => a.id) })
      })
    }

    if (!entry) return fail(404, 'not_found', 'no agent with this token')

    if (route === 'POST /asks') {
      if (agentOnly() === 'no') return fail(401, 'unauthorized', 'the agent proves itself with its secret')
      return body((b) => {
        const a = b as Ask
        if (!a || !ASK_ID.test(String(a.id))) return fail(400, 'invalid_request', 'id is 12 hex characters')
        const approve = String(a.messages?.approve ?? '')
        const refuse = String(a.messages?.refuse ?? '')
        // Only words this agent could have asked: its own, about a payment.
        const ours = (s: string, first: string) => s.length <= 1000 && s.startsWith(`${first}\nAgent: ${entry.agent}\n`)
        if (!ours(approve, 'Cellula agent: approve this payment') || !ours(refuse, 'Cellula agent: refuse this payment')) return fail(400, 'invalid_request', "the words are not this agent's words for a payment")
        const expires = Number(a.expires_at)
        if (!Number.isFinite(expires) || expires <= now() || expires > now() + ASK_LONGEST_MS) return fail(400, 'invalid_request', 'expires_at is within the next 15 minutes')
        const details = a.details && typeof a.details === 'object' && JSON.stringify(a.details).length <= 1024 ? a.details : {}
        if (entry.asks.some((x) => x.id === a.id)) return send(200, { ok: true })
        if (entry.asks.length >= OPEN_ASKS) return fail(429, 'too_many', 'too many payments waiting')
        if (total() > STATE_MOST) return fail(503, 'full', 'no room just now')
        entry.asks.push({ id: a.id, messages: { approve, refuse }, details, expires_at: expires })
        entry.updated_at = now()
        measure(token)
        o.save?.()
        send(200, { ok: true })
      })
    }

    if (route === 'GET ') {
      const open = entry.asks
        .filter((a) => a.expires_at > now())
        .map((a) => ({ ...a, answered: entry.answers.find((x) => x.ask_id === a.id)?.kind ?? null }))
      return send(200, { agent: entry.agent, approver: entry.approver, return_to: entry.return_to, status: entry.status, updated_at: entry.updated_at, asks: open })
    }

    if (route === 'POST /answers') {
      return body(async (b) => {
        const message = String(b?.message ?? '')
        const sig = b?.signature as WalletSignature
        if (message.length > 1500 || !sig || typeof sig.signature !== 'string' || sig.signature.length > SIGNATURE_MOST || [sig.identity, sig.signType].some((x) => typeof x !== 'string' || x.length > 4000))
          return fail(400, 'invalid_request', 'message and signature {signature, identity, signType}')
        const t = now()
        const ask = entry.asks.find((a) => a.expires_at > t && (a.messages.approve === message || a.messages.refuse === message))
        const kind = ask ? (ask.messages.approve === message ? 'approve' : 'refuse') : readCommand(entry.agent, entry.return_to, message, t) ? 'command' : null
        if (!kind) return fail(400, 'not_known', 'these are not the words of anything waiting, nor of a command for this agent')
        if (entry.answers.some((x) => x.message === message)) return send(200, { ok: true })
        // A check that failed (the chain not read just then) is said as such, for the page to try again.
        const signed = await checkSigned(o.client, message, sig, entry.approver)
        if (signed === 'unsure') return fail(503, 'try_again', 'the signature could not be checked just now: try again')
        if (signed === 'no') return fail(403, 'not_signed', "this is not signed by the wallet the agent was started with")
        if (total() > STATE_MOST) return fail(503, 'full', 'no room just now')
        entry.answers.push({ seq: ++entry.seq, kind, ask_id: ask?.id ?? null, message, signature: { signature: sig.signature, identity: sig.identity, signType: sig.signType }, at: t })
        entry.answers = keepAnswers(entry.answers)
        measure(token)
        o.save?.()
        o.log?.(`answer ${kind} for ${token.slice(0, 6)}`)
        send(200, { ok: true })
      })
    }

    if (route === 'GET /answers') {
      if (agentOnly() === 'no') return fail(401, 'unauthorized', 'the agent proves itself with its secret')
      const after = Number(url.searchParams.get('after') ?? 0)
      return send(200, { answers: entry.answers.filter((a) => a.seq > (Number.isFinite(after) ? after : 0)) })
    }

    fail(405, 'not_allowed', 'not like this')
  }
}
