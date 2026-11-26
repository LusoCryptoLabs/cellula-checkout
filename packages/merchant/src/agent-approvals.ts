// The person's page on the agent: payments waiting for their approval, a switch that stops every
// payment, taking the balance out, and what was paid and refused lately. It is not for the agent's
// caller: it takes its own key (printed in the agent's terminal when it starts), never the API's, so
// a model holding the API key cannot approve anything. Opened once with that key, the browser keeps a
// cookie for this page only.
//
//   GET  /approvals/sign-in?key=<approval key>   sets the cookie, then the page
//   GET  /approvals                              the page
//   POST /approvals/<id>/approve | /refuse       the person's answer
//   POST /approvals/pause | /resume              every payment stopped, or allowed again
//   POST /approvals/take-out  sure=1             the balance out, to the address fixed at start
//
// Only on this machine's own names (a page elsewhere pointing a name at 127.0.0.1 gets nothing), a
// form posted from another page is refused (Origin), and no other page can frame it.

import type http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Agent } from './agent.ts'
import { MerchantError } from './errors.ts'

const COOKIE = 'agent_approvals'
const digest = (s: string) => createHash('sha256').update(s).digest()
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  // Not no-referrer: under it a browser posts this page's own forms with Origin: null, and the
  // Origin check refuses them (seen in Chromium, 2026-11-01). Other sites still get no referrer.
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
}

/** Answers the approvals routes and returns true, or returns false for any other route. */
export function approvalsRoute(a: Agent, key: string | undefined, req: http.IncomingMessage, res: http.ServerResponse, url: URL, log?: (line: string) => void): boolean {
  if (url.pathname !== '/approvals' && !url.pathname.startsWith('/approvals/')) return false
  const page = (status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...HEADERS, ...extra })
    res.end(body)
  }
  const done = (status: number, body: string, extra: Record<string, string> = {}) => {
    page(status, body, extra)
    return true
  }
  if (!key) return done(404, shell('Not here', '<p>This agent was started without an approvals page.</p>'))
  const host = String(req.headers.host ?? '')
  if (!LOCAL_HOST.test(host)) return done(403, shell('Not here', '<p>Open this page at 127.0.0.1 or localhost.</p>'))

  if (url.pathname === '/approvals/sign-in' && req.method === 'GET') {
    const given = url.searchParams.get('key') ?? ''
    if (!given || !same(given, key)) return done(401, shell('Wrong key', '<p>Open the link the agent printed when it started.</p>'))
    return done(303, '', { location: '/approvals', 'set-cookie': `${COOKIE}=${digest(key).toString('hex')}; HttpOnly; SameSite=Strict; Path=/approvals` })
  }

  const cookie = String(req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1]
  if (!cookie || !same(cookie, digest(key).toString('hex'))) return done(401, shell('Sign in first', '<p>Open the link the agent printed when it started: it lets this browser in.</p>'))

  if (url.pathname === '/approvals' && req.method === 'GET') return done(200, render(a))

  if (req.method !== 'POST') return done(405, shell('Not like this', ''))
  // A form posted from another page carries that page's origin.
  if (req.headers.origin !== `http://${host}`) return done(403, shell('Refused', '<p>That came from another page.</p>'))
  const back = () => page(303, '', { location: '/approvals' })
  const act = url.pathname.match(/^\/approvals\/([0-9a-f]{12})\/(approve|refuse)$/)
  void (async () => {
    try {
      const form = new URLSearchParams(await small(req))
      if (act) a.decide(act[1]!, act[2] === 'approve')
      else if (url.pathname === '/approvals/pause') await a.pause(true)
      else if (url.pathname === '/approvals/resume') await a.pause(false)
      // The box ticked, checked here too: a form posted without it takes nothing out.
      else if (url.pathname === '/approvals/take-out' && form.get('sure') === '1') await a.takeOut()
      else if (url.pathname === '/approvals/take-out') return page(400, shell('Not done', '<p>Tick the box first.</p><p><a href="/approvals">Back</a></p>'))
      else return page(404, shell('Not here', ''))
      back()
    } catch (e) {
      if (e instanceof MerchantError) return page(e.status, shell('Not done', `<p>${esc(e.message)}</p><p><a href="/approvals">Back</a></p>`), e.status === 413 ? { connection: 'close' } : {})
      log?.(`approvals: ${e instanceof Error ? e.message : String(e)}`)
      page(500, shell('Not done', '<p>Something failed on the agent side.</p>'))
    }
  })()
  return true
}

/** A form's body, up to 1 kB: the page's own forms hold one field at most. */
function small(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let over = false
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      if (over) return
      body += c
      // Answered 413 and the rest read and dropped: cutting the connection here left the browser a
      // reset instead of the answer.
      if (body.length > 1024) {
        over = true
        body = ''
        reject(new MerchantError('too_large', 'that form is too large', 413))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/** Taking the balance out: where it stands, or the form that starts it. */
function takeOutBlock(st: ReturnType<Agent['status']>): string {
  const t = st.take_out
  const to = `<span class="addr">${esc(t?.to ?? st.return_to)}</span>`
  if (t?.status === 'waiting') return `<p>Taking it out once the payment on its way has ended; no new payment starts meanwhile. Then it goes to ${to}.</p>`
  if (t?.status === 'closing') return `<p>Taking it out: closing the channel with the LSP, about a minute. Then it goes to ${to}.</p>`
  if (t?.status === 'closed') return `<p>${t.to ? `Closed, and on its way to ${to}.` : 'Closed. It stays at the agent&#39;s own address.'}</p>`
  if (t?.status === 'returned') {
    const later = (t.later ?? []).map((x) => `<span class="addr">${esc(x)}</span>`).join(', ')
    return `<p>Taken out: sent to ${to}, transaction <span class="addr">${esc(t.tx)}</span>${later ? `, and what came later in ${later}` : ''}.</p>`
  }
  const failed = t?.status === 'failed' ? `<p class="warn">The take-out did not finish: ${esc(t.error)}</p>` : ''
  if (!st.ready) return `${failed}<p class="muted">Nothing to take out: no channel is open.</p>`
  if (!st.return_to) return `${failed}<p class="muted">It was started without your address, so a take-out would stay at the agent&#39;s own.</p>`
  return `${failed}
    <form method="post" action="/approvals/take-out" class="takeout">
      <label><input type="checkbox" name="sure" value="1" required><span>Close its balance and send it to ${to}, the address you gave when you started it.</span></label>
      <button class="stop">Take it all out</button>
    </form>`
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`
}

function render(a: Agent): string {
  const st = a.status()
  const now = Date.now()
  // Oldest first: one asked while the page is open goes below, so the card under the person's finger
  // stays where it is through the page's refresh.
  const waiting = a
    .approvals()
    .filter((x) => x.status === 'waiting')
    .reverse()
  const decided = a.approvals().filter((x) => x.status !== 'waiting').slice(0, 10)
  const caps = [
    `${esc(st.caps.per_payment_ckb ?? 'any')} CKB a payment`,
    st.caps.day_ckb ? `${esc(st.caps.day_left_ckb)} of ${esc(st.caps.day_ckb)} CKB left in 24 h` : null,
    st.caps.total_ckb ? `${esc(st.caps.left_ckb)} of ${esc(st.caps.total_ckb)} CKB left in all` : null,
    st.approve_above_ckb ? `you approve above ${esc(st.approve_above_ckb)} CKB` : null,
    st.allow ? `pays only ${st.allow.map(esc).join(', ')}` : null,
  ].filter(Boolean)
  const card = (x: ReturnType<Agent['approvals']>[number]) => `
    <li class="card">
      <div class="amount">${esc(x.amount_ckb)} CKB</div>
      <div>${x.seller ? `to <b>${esc(x.seller)}</b>` : 'an invoice given as is'}</div>
      ${x.memo ? `<div class="what">${esc(x.memo)}</div>` : ''}
      <div class="muted">asked ${ago(now - x.asked_at)} ago, waits ${ago(x.expires_at - now)} more</div>
      <div class="row">
        <form method="post" action="/approvals/${esc(x.id)}/approve"><button class="yes">Approve</button></form>
        <form method="post" action="/approvals/${esc(x.id)}/refuse"><button>Refuse</button></form>
      </div>
    </li>`
  const line = (when: number, what: string) => `<li><span class="muted">${ago(now - when)} ago</span> ${what}</li>`
  const body = `
    <p class="lead">Balance ${esc(st.balance_ckb)} CKB, ${esc(st.spent_ckb)} CKB spent.</p>
    <p class="muted">${caps.join(' · ')}</p>
    ${
      st.paused
        ? '<div class="banner">Every payment is stopped.</div><form method="post" action="/approvals/resume"><button class="yes">Let it pay again</button></form>'
        : '<form method="post" action="/approvals/pause"><button class="stop">Stop every payment</button></form>'
    }
    <h2>Waiting for you</h2>
    ${waiting.length ? `<ul class="cards">${waiting.map(card).join('')}</ul>` : '<p class="muted">Nothing waits.</p>'}
    <h2>Paid lately</h2>
    ${(() => {
      const paid = a.payments({ limit: 10 })
      return paid.length ? `<ul class="list">${paid.map((p) => line(p.created_at, `${esc(p.amount_ckb)} CKB, ${esc(p.status)}${p.memo ? `, ${esc(p.memo)}` : ''}`)).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'
    })()}
    <h2>Refused lately</h2>
    ${(() => {
      const no = a.refusals().slice(0, 10)
      return no.length ? `<ul class="list">${no.map((r) => line(r.at, `${esc(r.code)}: ${esc(r.message)}`)).join('')}</ul>` : '<p class="muted">Nothing refused.</p>'
    })()}
    ${decided.length ? `<h2>Decided</h2><ul class="list">${decided.map((x) => line(x.asked_at, `${esc(x.amount_ckb)} CKB${x.seller ? ` to ${esc(x.seller)}` : ''}: ${esc(x.status)}`)).join('')}</ul>` : ''}
    <h2>Take it out</h2>
    ${takeOutBlock(st)}`
  return shell('Fiber agent', body, true)
}

function shell(title: string, body: string, refresh = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="5">' : ''}<title>${esc(title)}</title>
<style>
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #fff; --yes: #15803d; --stop: #b91c1c; color-scheme: light dark }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --card: #292524; --yes: #22c55e; --stop: #f87171 } }
* { box-sizing: border-box }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; overflow-wrap: break-word }
main { max-width: 560px; margin: 0 auto }
h1 { font-size: 22px; margin: 0 0 8px }
h2 { font-size: 15px; margin: 28px 0 8px; color: var(--muted); font-weight: 600 }
.lead { margin: 0 }
.muted { color: var(--muted); font-size: 14px }
ul { list-style: none; padding: 0; margin: 0 }
.cards li { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 10px }
.amount { font-size: 20px; font-weight: 700 }
.what { font: 14px/1.4 ui-monospace, monospace; margin: 4px 0 2px }
.list li { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 14px }
.row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap }
form { margin: 0 }
button { font: inherit; padding: 10px 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; min-height: 44px }
button.yes { background: var(--yes); border-color: var(--yes); color: #fff }
button.stop { margin-top: 12px; border-color: var(--stop); color: var(--stop) }
.banner { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--stop); color: #fff; font-weight: 600 }
.banner + form button { margin-top: 10px }
.addr { font: 13px/1.4 ui-monospace, monospace; word-break: break-all }
.warn { color: var(--stop) }
.takeout label { display: flex; gap: 10px; align-items: flex-start; font-size: 14px }
.takeout input { width: 22px; height: 22px; margin: 1px 0 0; flex: none }
.takeout button { margin-top: 10px }
</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`
}
