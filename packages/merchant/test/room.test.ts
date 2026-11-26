// Renting room to receive from the LSP (room.ts, merchant.ts): asked and paid, brought into a
// channel once nothing is open to be paid (hosted: the rent moves to the next tenant after a new
// start), told a week before the end and at the end, quiet when a rent paid since follows it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Merchant, type Rent } from '../src/merchant.ts'
import { MerchantError } from '../src/errors.ts'
import type { RailRent, RoomRail } from '../src/room.ts'
import { ownNodeRoom } from '../src/room.ts'
import { FakeSession } from './fake.ts'

const CKB = 100_000_000n
const DAY = 86_400_000
const dir = () => mkdtempSync(path.join(tmpdir(), 'room-'))

/** A gateway that rents: each rent paid at once (or never, `pays: false`), 30 days from now or from
 * the end of the rent before it. */
function rail(o: { hosted: boolean; pays?: boolean; now: () => number }) {
  const rents: RailRent[] = []
  const calls: string[] = []
  const r: RoomRail & { rents: RailRent[]; calls: string[] } = {
    rents,
    calls,
    terms: async () => ({ perMonth: 0.01, least: 1000n * CKB, most: 50000n * CKB, monthMs: 30 * DAY }),
    async rent(room, months) {
      calls.push(`rent ${room / CKB}`)
      const last = rents.filter((x) => x.paid).map((x) => x.until!).sort((a, b) => b - a)[0]
      const start = Math.max(o.now(), last ?? 0)
      const paid = o.pays !== false
      const x: RailRent = { paymentHash: `0x${rents.length + 1}`, room, months, price: (room * BigInt(months)) / 100n, paid, start: paid ? start : null, until: paid ? start + months * 30 * DAY : null, ended: false, closed: false, claim: `claim${rents.length + 1}` }
      rents.push(x)
      return { ...x }
    },
    status: async (h) => ({ ...rents.find((x) => x.paymentHash === h)! }),
    place: async () => void calls.push('place'),
    ...(o.hosted ? { move: async (h: string, claim: string) => void calls.push(`move ${h} ${claim}`) } : {}),
  }
  return r
}

async function shop(o: { hosted?: boolean; pays?: boolean; file?: string; place?: 'idle' | 'manual' } = {}) {
  let t = 1_800_000_000_000
  const now = () => t
  const room = rail({ hosted: !!o.hosted, pays: o.pays, now })
  const events: string[] = []
  const m = await Merchant.open({ session: new FakeSession(now), file: o.file ?? path.join(dir(), 'm.json'), now, sweepMs: 3_600_000, room, roomPlace: o.place })
  for (const e of ['room.placed', 'room.ending', 'room.ended'] as const) m.onRoom(e, (r: Rent) => events.push(`${e} ${r.payment_hash}`))
  const sweep = () => (m as unknown as { sweep(): Promise<void> }).sweep()
  return { m, room, events, sweep, at: (ms: number) => void (t = ms), now }
}

test('what more room costs, as the LSP says', async () => {
  const { m } = await shop()
  assert.deepEqual(await m.roomTerms(), { per_month: 0.01, least_ckb: '1000', most_ckb: '50000', month_days: 30 })
  m.close()
})

test('a rent paid on a shop on its own node: a second channel once nothing is open, told placed', async () => {
  const { m, room, events, sweep } = await shop()
  const inv = await m.createInvoice({ amount_ckb: 1 })
  const rent = await m.rentRoom({ room_ckb: 5000 })
  assert.equal(rent.status, 'waiting')
  assert.equal(rent.price_ckb, '50')
  assert.equal((rent as Record<string, unknown>).claim, undefined, 'the claim stays inside')
  await sweep()
  assert.deepEqual(room.calls, ['rent 5000'], 'control: an invoice open, nothing is closed or opened')
  ;(m as unknown as { db: { value: { invoices: { status: string }[] } } }).db.value.invoices.find((i) => i.status === 'open')!.status = 'expired'
  void inv
  await sweep()
  assert.deepEqual(room.calls, ['rent 5000', 'place'])
  assert.equal(m.rents()[0]!.status, 'running')
  assert.deepEqual(events, ['room.placed 0x1'])
  m.close()
})

test('placed by hand only when the shop says so', async () => {
  const { m, room, sweep } = await shop({ place: 'manual' })
  await m.rentRoom({ room_ckb: 2000 })
  await sweep()
  assert.deepEqual(room.calls, ['rent 2000'])
  await m.placeRoom()
  assert.deepEqual(room.calls, ['rent 2000', 'place'])
  m.close()
})

test('hosted: the rent waits to move, and after a new start it moves to the new tenant before the opening', async () => {
  const file = path.join(dir(), 'm.json')
  const first = await shop({ hosted: true, file })
  await first.m.rentRoom({ room_ckb: 3000 })
  await first.sweep()
  assert.deepEqual(first.room.calls, ['rent 3000', 'place'])
  assert.equal(first.m.rents()[0]!.status, 'moving', 'kept as moving: the process starts again on the way')
  await assert.rejects(first.m.rentRoom({ room_ckb: 1000 }), (e) => e instanceof MerchantError && e.code === 'busy')
  first.m.close()
  // The service starts the shop again: the rent moves with its claim, then it is running.
  const again = await shop({ hosted: true, file })
  assert.deepEqual(again.room.calls, ['move 0x1 claim1'])
  assert.equal(again.m.rents()[0]!.status, 'running')
  // room.placed went out during the start, before a listener could be added: a webhook carries it.
  again.m.close()
})

test('told a week before the end and at the end, once each', async () => {
  const { m, events, sweep, at, now } = await shop()
  const rent = await m.rentRoom({ room_ckb: 2000 })
  await sweep()
  events.length = 0
  at(rent.until! - 8 * DAY)
  await sweep()
  assert.deepEqual(events, [], 'control: more than a week left, nothing said')
  at(rent.until! - 6 * DAY)
  await sweep()
  await sweep()
  assert.deepEqual(events, ['room.ending 0x1'])
  at(rent.until! + 1)
  await sweep()
  await sweep()
  assert.deepEqual(events, ['room.ending 0x1', 'room.ended 0x1'])
  assert.equal(m.rents()[0]!.status, 'ended')
  void now
  m.close()
})

test('renewed before the end: the renewal follows the rent, needs no channel, and nothing is said', async () => {
  const { m, room, events, sweep, at } = await shop()
  const first = await m.rentRoom({ room_ckb: 2000 })
  await sweep()
  const renewal = await m.rentRoom({ room_ckb: 2000 })
  assert.equal(renewal.start, first.until, 'it starts at the end of the first')
  assert.equal(renewal.status, 'running', 'as much room as runs now: no new channel')
  events.length = 0
  at(first.until! - 6 * DAY)
  await sweep()
  at(first.until! + 1)
  await sweep()
  assert.deepEqual(events, [], 'followed: neither ending nor ended is said for the first')
  assert.deepEqual(room.calls.filter((c) => c === 'place'), ['place'], 'one channel for both')
  m.close()
})

test('a rent not paid is dropped after two hours; renting needs a rail', async () => {
  const { m, sweep, at, now } = await shop({ pays: false })
  const rent = await m.rentRoom({ room_ckb: 2000 })
  assert.equal(rent.status, 'unpaid')
  at(now() + 3 * 3_600_000)
  await sweep()
  assert.deepEqual(m.rents(), [])
  m.close()
  const bare = await Merchant.open({ session: new FakeSession(), file: path.join(dir(), 'm.json') })
  await assert.rejects(bare.rentRoom({ room_ckb: 2000 }), (e) => e instanceof MerchantError && e.code === 'no_room')
  bare.close()
})

test("on its own node: asked with the node's key, paid by the node, the room in a second channel", async () => {
  const asked: { url: string; body?: unknown }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    asked.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (String(url).endsWith('/rent')) return new Response(JSON.stringify({ payment_hash: '0xabc', invoice: 'fibt-rent', claim: 'c1', price: 20 * 1e8 }))
    return new Response(JSON.stringify({ room: 2000 * 1e8, months: 1, price: 20 * 1e8, paid: 1, start: 1000, until: 2000 }))
  }) as typeof fetch
  const node = { paid: [] as string[], opened: [] as string[], pubkey: async () => '03' + 'cc'.repeat(32), pay: async (i: string) => void node.paid.push(i), openChannel: async (k: string, ckb: bigint) => void node.opened.push(`${k} ${ckb}`) }
  const r = ownNodeRoom({ gateway: 'https://g/lsp2', lspPubkey: '032c', node, fetch: f })
  const rent = await r.rent(2000n * CKB, 1)
  assert.deepEqual(asked[0]!.body, { pubkey: '03' + 'cc'.repeat(32), room_ckb: 2000, months: 1 })
  assert.deepEqual(node.paid, ['fibt-rent'])
  assert.equal(rent.paid, true)
  assert.equal(rent.until, 2_000_000)
  await r.place()
  assert.deepEqual(node.opened, ['032c 109'])
})
