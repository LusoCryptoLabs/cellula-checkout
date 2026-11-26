// Webhooks, signed the way Stripe signs them so shops already know how to check them: the header
// `Fiber-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the shared secret>`.
// A delivery that fails is tried again, later each time, and survives a restart.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type WebhookTarget = { url: string; secret: string }

export type WebhookEvent = { id: string; type: string; created: number; data: Record<string, unknown> }

/** A delivery not yet answered with a 2xx. */
export type Pending = { event: WebhookEvent; attempts: number; next_at: number; last_error?: string }

/** The waits before each new attempt: at once, then 10 s, 1 min, 5 min, 30 min, 2 h, 6 h, 24 h. */
export const RETRY_MS = [0, 10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000]

const hmac = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex')

export function signWebhook(body: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmac(secret, `${t}.${body}`)}`
}

/** True when `header` signs exactly `body` (the raw text, before any JSON parsing) with `secret`,
 * within `toleranceSec` of now. Compared in constant time. */
export function verifyWebhook(body: string, header: string | null | undefined, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header || !secret) return false
  const parts = header.split(',').map((p) => p.trim().split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSec) return false
  const want = Buffer.from(hmac(secret, `${t}.${body}`), 'hex')
  return parts.some(([k, v]) => {
    if (k !== 'v1' || !v || !/^[0-9a-f]{64}$/.test(v)) return false
    return timingSafeEqual(Buffer.from(v, 'hex'), want)
  })
}

export const eventId = () => `evt_${randomBytes(12).toString('hex')}`

type WebhooksOptions = {
  target: WebhookTarget
  /** Where the deliveries not yet answered are kept, so a restart tries them again. */
  load: () => Pending[]
  save: (pending: Pending[]) => Promise<void>
  fetch?: typeof fetch
  now?: () => number
  log?: (line: string) => void
  /** The waits before each attempt (RETRY_MS unless told; tests make them short). */
  retryMs?: number[]
}

export class Webhooks {
  private o: WebhooksOptions
  private pending: Pending[]
  private timer: ReturnType<typeof setTimeout> | null = null
  private sending = false
  private stopped = false

  constructor(o: WebhooksOptions) {
    this.o = o
    this.pending = o.load()
  }

  private now() {
    return (this.o.now ?? Date.now)()
  }

  /** Queue an event and try it at once. Resolves once it is queued (the delivery goes on). */
  async send(type: string, data: Record<string, unknown>): Promise<WebhookEvent> {
    const event: WebhookEvent = { id: eventId(), type, created: Math.floor(this.now() / 1000), data }
    this.pending.push({ event, attempts: 0, next_at: this.now() })
    await this.o.save(this.pending)
    void this.run()
    return event
  }

  /** Try what is due again; called on start, after a restart. */
  resume(): void {
    void this.run()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  /** What is still waiting for a 2xx, oldest first. */
  waiting(): Pending[] {
    return this.pending.map((p) => ({ ...p }))
  }

  private async attempt(p: Pending): Promise<boolean> {
    const body = JSON.stringify(p.event)
    try {
      const r = await (this.o.fetch ?? fetch)(this.o.target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'pay-with-fiber/0.0.1',
          'fiber-event-id': p.event.id,
          'fiber-signature': signWebhook(body, this.o.target.secret, Math.floor(this.now() / 1000)),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (r.ok) return true
      p.last_error = `answered ${r.status}`
    } catch (e) {
      p.last_error = e instanceof Error ? e.message : String(e)
    }
    return false
  }

  private async run(): Promise<void> {
    if (this.sending || this.stopped) return
    this.sending = true
    try {
      for (;;) {
        const now = this.now()
        const due = this.pending.find((p) => p.next_at <= now)
        if (!due) break
        if (await this.attempt(due)) {
          this.pending = this.pending.filter((p) => p !== due)
          this.o.log?.(`webhook ${due.event.type} ${due.event.id} delivered`)
        } else {
          due.attempts++
          const waits = this.o.retryMs ?? RETRY_MS
          if (due.attempts >= waits.length) {
            this.pending = this.pending.filter((p) => p !== due)
            this.o.log?.(`webhook ${due.event.type} ${due.event.id} dropped after ${due.attempts} attempts: ${due.last_error}`)
          } else {
            const wait = waits[due.attempts] ?? 0
            due.next_at = now + wait
            this.o.log?.(`webhook ${due.event.type} ${due.event.id} failed (${due.last_error}); next try in ${Math.round(wait / 1000)} s`)
          }
        }
        await this.o.save(this.pending)
      }
    } finally {
      this.sending = false
    }
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const next = Math.min(...this.pending.map((p) => p.next_at))
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => void this.run(), Math.max(0, next - this.now()))
      this.timer.unref?.()
    }
  }
}
