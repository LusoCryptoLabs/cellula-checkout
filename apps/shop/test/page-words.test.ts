// The shop's page (public/shop.js) joins a reason to its own words. A reason that ended in a period got
// another: "...open one here.. You can try again." Here the page runs in
// a stand-in browser: its products, an order, and Pay with Fiber refusing with the reason given.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const PAGE = readFileSync(new URL('../public/shop.js', import.meta.url), 'utf8')
const tick = () => new Promise((r) => setTimeout(r, 0))

type El = { textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; className: string; onclick?: () => Promise<void>; kids: Record<string, El>; on: Record<string, () => void>; classList: { toggle(): void; add(): void }; querySelector(s: string): El; addEventListener(t: string, f: () => void): void }
function el(): El {
  const e: El = {
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    className: '',
    kids: {},
    on: {},
    classList: { toggle() {}, add() {} },
    querySelector: (s) => (e.kids[s] ??= el()),
    addEventListener: (t, f) => void (e.on[t] = f),
  }
  return e
}

/** The page with an order that `refuse` fails to pay, or a shop that refuses the order (`order`). */
async function page(opts: { refuse?: unknown; order?: { status: number; error: string } }) {
  const ids: Record<string, El> = {}
  const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body })
  const window = {
    payWithFiber: async () => {
      throw opts.refuse
    },
  }
  runInNewContext(PAGE, {
    window,
    document: { getElementById: (id: string) => (ids[id] ??= el()) },
    location: { search: '', origin: 'https://shop.example' },
    URLSearchParams,
    setTimeout,
    fetch: async (path: string) => {
      if (path === '/api/products') return answer(200, { products: [{ id: 'mug', name: 'Mug', blurb: '', price_ckb: '10' }] })
      if (path === '/api/status') return answer(200, { ready: true, can_receive_ckb: '200' })
      if (path === '/api/orders') return opts.order ? answer(opts.order.status, { error: opts.order.error }) : answer(200, { order: { id: 'o_0123456789ab' }, invoice: 'fibt1...' })
      return answer(404, {})
    },
  })
  for (let i = 0; i < 5; i++) await tick()
  const card = ids.products!.querySelector('[data-id="mug"]')
  card.querySelector('.buy').on.click!()
  for (let i = 0; i < 5; i++) await tick()
  if (!opts.order) await card.querySelector('.pay').onclick!()
  return card.querySelector('.line').textContent
}

test('a reason that ends in its own period is not given a second one', async () => {
  const said = await page({ refuse: new Error('This wallet already has 2 Fiber balances open, the most it can have. Take one out to open one here.') })
  assert.equal(said, 'Not paid: This wallet already has 2 Fiber balances open, the most it can have. Take one out to open one here. You can try again.')
  assert.doesNotMatch(said, /\.\./)
})

test('a reason with no period gets one, and a window closed with no reason says so', async () => {
  assert.equal(await page({ refuse: new Error('the payment was refused') }), 'Not paid: the payment was refused. You can try again.')
  assert.equal(await page({ refuse: new Error('') }), 'Not paid: the window closed. You can try again.')
  assert.equal(await page({ refuse: new Error('Is it paid?') }), 'Not paid: Is it paid? You can try again.')
})

test("the shop's own refusal of an order is said as a sentence", async () => {
  const said = await page({ order: { status: 503, error: 'the shop is still opening its channel; try again in a minute' } })
  assert.equal(said, 'The shop is still opening its channel; try again in a minute.')
})
