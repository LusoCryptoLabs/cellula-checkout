// The agent's rules: it pays within the person's caps, once per invoice, keeps the receipt, and
// takes its balance out only to the person's address.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Agent, type AgentCaps, type AgentOptions } from '../src/agent.ts'
import { MerchantError } from '../src/errors.ts'
import { SHANNONS } from '../src/amount.ts'
import { FakeNet, FakePayer } from './fake-payer.ts'
import { sleep } from './fake.ts'

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'agent-')), 'agent.json')
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e) {
    return e instanceof MerchantError ? `${e.code} ${e.status}` : String(e)
  }
}
const ckb = (n: number) => BigInt(Math.round(n * 1e8))
/** Up to two seconds for a condition (or `ms`): a payment's end and its receipt come a moment apart. */
const until = async (ok: () => boolean, ms = 2_000) => {
  for (let i = 0; i < ms / 10 && !ok(); i++) await sleep(10)
}

type AgentTestOptions = { waitMs?: number; returnTo?: string; sweep?: (to: string) => Promise<string>; balance?: () => Promise<bigint>; sweepAgainMs?: number; file?: string; payer?: FakePayer; now?: () => number } & Pick<AgentOptions, 'allow' | 'approveAboveCkb' | 'approvalsUrl' | 'approvalMs'>

async function agent(caps: AgentCaps = {}, o: AgentTestOptions = {}) {
  const net = new FakeNet()
  const payer = o.payer ?? new FakePayer(net)
  const a = await Agent.open({ session: payer, file: o.file ?? file(), caps, waitMs: o.waitMs ?? 2_000, returnTo: o.returnTo, sweep: o.sweep, balance: o.balance, sweepAgainMs: o.sweepAgainMs, closeWaitMs: 2_000, now: o.now, allow: o.allow, approveAboveCkb: o.approveAboveCkb, approvalsUrl: o.approvalsUrl, approvalMs: o.approvalMs })
  return { net: payer.net, payer, a }
}

test('an invoice within the caps is paid, and the receipt is kept', async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 1, total_ckb: 5 })
  const b = net.bill(ckb(0.5))
  const p = await a.pay({ invoice: b.invoice, memo: 'one name report' })
  assert.equal(p.status, 'paid')
  assert.equal(p.preimage, b.preimage, 'the payee secret is the receipt')
  assert.equal(p.amount_ckb, '0.5')
  assert.deepEqual(payer.pays, [b.hash])
  assert.equal(a.status().spent_ckb, '0.5')
  assert.equal(a.status().caps.left_ckb, '4.5')
  assert.equal(a.get(b.hash)?.status, 'paid')
})

test('past a cap nothing is asked of the signer', async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 1, total_ckb: 2 })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1.5)).invoice })), 'over_cap 422', 'per payment')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.8)).invoice, max_ckb: '0.5' })), 'over_cap 422', "the caller's own limit")
  await a.pay({ invoice: net.bill(ckb(1)).invoice })
  await a.pay({ invoice: net.bill(ckb(0.75)).invoice })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.5)).invoice })), 'over_cap 422', 'the total: 1.75 spent of 2')
  assert.equal(payer.pays.length, 2, 'only the two within the caps were paid')
  // Control: no caps, the same invoice is paid.
  const free = await agent()
  assert.equal((await free.a.pay({ invoice: free.net.bill(ckb(1.5)).invoice })).status, 'paid')
})

test('what was spent still counts against the total after a restart', async () => {
  const f = file()
  const { net, payer, a } = await agent({ per_payment_ckb: 1, total_ckb: 2 }, { file: f })
  await a.pay({ invoice: net.bill(ckb(1)).invoice })
  await a.pay({ invoice: net.bill(ckb(0.75)).invoice })
  const after = await agent({ per_payment_ckb: 1, total_ckb: 2 }, { file: f, payer })
  assert.equal(after.a.status().spent_ckb, '1.75')
  assert.equal(after.a.status().caps.left_ckb, '0.25')
  assert.equal(await code(after.a.pay({ invoice: net.bill(ckb(0.5)).invoice })), 'over_cap 422')
  assert.equal(payer.pays.length, 2, 'nothing more was asked of the signer')
  // Control: an agent with nothing spent pays the same amount.
  const fresh = await agent({ per_payment_ckb: 1, total_ckb: 2 })
  assert.equal((await fresh.a.pay({ invoice: fresh.net.bill(ckb(0.5)).invoice })).status, 'paid')
})

// Holds while nothing is awaited between the caps and the record (agent.ts start).
test('two payments at once cannot both pass a cap only one fits in', async () => {
  const { net, payer, a } = await agent({ total_ckb: 1 })
  const r = await Promise.all([code(a.pay({ invoice: net.bill(ckb(0.6)).invoice })), code(a.pay({ invoice: net.bill(ckb(0.6)).invoice }))])
  assert.deepEqual(r.sort(), ['no error', 'over_cap 422'])
  assert.equal(payer.pays.length, 1)
})

test('the most in any 24 hours counts back from each payment, across a restart', async () => {
  let t = 1_800_000_000_000
  const now = () => t
  const f = file()
  const { net, payer, a } = await agent({ per_payment_ckb: 1, day_ckb: 2 }, { now, file: f })
  await a.pay({ invoice: net.bill(ckb(1)).invoice })
  t += 60 * 60_000
  await a.pay({ invoice: net.bill(ckb(0.75)).invoice })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.5)).invoice })), 'over_cap 422', '1.75 of 2 in 24 hours')
  assert.equal(a.status().caps.day_left_ckb, '0.25')
  t += 23 * 60 * 60_000 + 1 // the first payment is now more than 24 hours back
  assert.equal((await a.pay({ invoice: net.bill(ckb(0.5)).invoice })).status, 'paid')
  const again = await agent({ per_payment_ckb: 1, day_ckb: 2 }, { now, file: f, payer })
  assert.equal(again.a.status().caps.day_left_ckb, '0.75', '0.75 and 0.5 in the last 24 hours')
  assert.equal(await code(again.a.pay({ invoice: net.bill(ckb(1)).invoice })), 'over_cap 422')
  assert.equal(payer.pays.length, 3, 'only those within it were paid')
})

const PAYEE = '02' + 'cd'.repeat(32)
const OTHER_PAYEE = '03' + 'ef'.repeat(32)

test("the LSP's own node key is refused in the allow list: every seller it hosts is paid there", async () => {
  const net = new FakeNet()
  const open = (allow: string[]) => Agent.open({ session: new FakePayer(net), file: file(), caps: { per_payment_ckb: 1 }, allow, sharedPayees: [`0x${PAYEE}`] })
  await assert.rejects(open(['api.example.com', PAYEE]), /is the LSP's node key, which every seller it hosts is paid at/)
  await assert.rejects(open([`0x${PAYEE.toUpperCase()}`]), /LSP's node key/, 'written with 0x and in capitals')
  // Control: another node's key, and host names, are taken.
  const ok = await open(['api.example.com', OTHER_PAYEE])
  assert.deepEqual(ok.status().allow, ['api.example.com', OTHER_PAYEE])
})

test('it pays only the sellers and payees the person allows, and keeps what it refused', async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 1 }, { allow: ['api.example.com', PAYEE] })
  assert.equal((await a.pay({ invoice: net.bill(ckb(0.1)).invoice, seller: 'api.example.com' })).status, 'paid', 'an allowed seller')
  assert.equal((await a.pay({ invoice: net.bill(ckb(0.1)).invoice, seller: 'API.Example.com' })).status, 'paid', 'in any case')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.1)).invoice, seller: 'other.example.com', memo: 'a report' })), 'not_allowed 403', 'another seller')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.1)).invoice })), 'not_allowed 403', 'an invoice given as is, its payee not allowed')
  assert.equal((await a.pay({ invoice: net.bill(ckb(0.1), { payee: PAYEE }).invoice })).status, 'paid', 'an allowed payee')
  assert.equal(payer.pays.length, 3)
  assert.deepEqual(
    a.refusals().map((r) => [r.code, r.seller, r.memo]),
    [
      ['not_allowed', null, ''],
      ['not_allowed', 'other.example.com', 'a report'],
    ],
  )
  // Control: with no list, the same seller is paid.
  const any = await agent({ per_payment_ckb: 1 })
  assert.equal((await any.a.pay({ invoice: any.net.bill(ckb(0.1)).invoice, seller: 'other.example.com' })).status, 'paid')
})

test('above the approval amount a payment waits for the person; one approval lets one go', async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 2 }, { approveAboveCkb: '0.5', approvalsUrl: 'http://127.0.0.1:8280/approvals' })
  assert.equal((await a.pay({ invoice: net.bill(ckb(0.5)).invoice })).status, 'paid', 'at the amount itself, no approval')
  const big = net.bill(ckb(1))
  const asked = await a.pay({ invoice: big.invoice }).catch((e: MerchantError) => e)
  assert.equal(asked instanceof MerchantError && asked.code, 'needs_approval')
  assert.match((asked as MerchantError).message, /approve it at http:\/\/127\.0\.0\.1:8280\/approvals/, 'says where')
  assert.equal(await code(a.pay({ invoice: big.invoice })), 'needs_approval 403', 'asked again while it waits')
  const waiting = a.approvals().filter((x) => x.status === 'waiting')
  assert.equal(waiting.length, 1, 'asked of the person once')
  assert.equal(waiting[0]!.amount_ckb, '1')
  assert.equal(a.status().waiting_approvals, 1)
  assert.deepEqual(a.refusals(), [], 'waiting is not refused')
  assert.equal(payer.pays.length, 1, 'nothing more asked of the signer')
  a.decide(waiting[0]!.id, true)
  assert.equal((await a.pay({ invoice: big.invoice })).status, 'paid')
  assert.equal(a.approvals()[0]!.status, 'used')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice })), 'needs_approval 403', 'another invoice asks again')
  // Control: with no approval amount, the same payment goes.
  const free = await agent({ per_payment_ckb: 2 })
  assert.equal((await free.a.pay({ invoice: free.net.bill(ckb(1)).invoice })).status, 'paid')
})

// Any node can make an invoice with a payment hash it is given: an approval of a 0.6 CKB card must
// not let a second invoice with the same hash, for 10 CKB to another node, be paid on it.
test("an invoice given as is: its approval holds for its payee and amount, not for another invoice with its hash", async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 10, total_ckb: 50 }, { approveAboveCkb: '0.5' })
  const small = net.bill(ckb(0.6))
  assert.equal(await code(a.pay({ invoice: small.invoice })), 'needs_approval 403')
  a.decide(a.approvals()[0]!.id, true)
  const twin = (amount: number, payee: string) => {
    const invoice = `fibttwin${amount}x${payee.slice(-4)}`
    net.bills.set(invoice, { hash: small.hash, preimage: small.preimage, amount: ckb(amount), expired: false, currency: 'Fibt', payee })
    return invoice
  }
  assert.equal(await code(a.pay({ invoice: twin(10, '03' + 'ab'.repeat(32)) })), 'needs_approval 403', 'the same hash, more, to another node')
  assert.equal(await code(a.pay({ invoice: twin(10, '02lsp') })), 'needs_approval 403', 'the same hash and payee, more')
  assert.equal(payer.pays.length, 0)
  // Control: the invoice the person saw goes through, once.
  assert.equal((await a.pay({ invoice: small.invoice })).status, 'paid')
  assert.equal(payer.pays.length, 1)
})

test("a seller's approval is used by its next invoice, to the same payee and for no more", async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 2 }, { approveAboveCkb: '0.5' })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1), { payee: PAYEE }).invoice, seller: 's.example' })), 'needs_approval 403')
  a.decide(a.approvals()[0]!.id, true)
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1), { payee: PAYEE }).invoice, seller: 'other.example' })), 'needs_approval 403', 'another seller')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1.5), { payee: PAYEE }).invoice, seller: 's.example' })), 'needs_approval 403', 'more than approved')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1), { payee: OTHER_PAYEE }).invoice, seller: 's.example' })), 'needs_approval 403', 'another payee')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1), { payee: PAYEE }).invoice })), 'needs_approval 403', 'an invoice given as is')
  assert.equal(payer.pays.length, 0)
  assert.equal((await a.pay({ invoice: net.bill(ckb(0.8), { payee: PAYEE }).invoice, seller: 's.example' })).status, 'paid', "the seller's new invoice, within it")
  assert.equal(payer.pays.length, 1)
})

test('a refusal stands for its time, and an approval not used in time runs out', async () => {
  let t = 1_800_000_000_000
  const { net, payer, a } = await agent({ per_payment_ckb: 2 }, { approveAboveCkb: '0.5', approvalMs: 60_000, now: () => t })
  const b = net.bill(ckb(1))
  assert.equal(await code(a.pay({ invoice: b.invoice })), 'needs_approval 403')
  a.decide(a.approvals()[0]!.id, false)
  assert.equal(await code(a.pay({ invoice: b.invoice })), 'refused_by_person 403')
  t += 60_001
  assert.equal(await code(a.pay({ invoice: b.invoice })), 'needs_approval 403', 'asked anew once the refusal ran out')
  const c = net.bill(ckb(1))
  assert.equal(await code(a.pay({ invoice: c.invoice })), 'needs_approval 403')
  const id = a.approvals()[0]!.id
  a.decide(id, true)
  t += 60_001
  assert.equal(await code(a.pay({ invoice: c.invoice })), 'needs_approval 403', 'approved, but not used in time')
  assert.equal(a.approvals().find((x) => x.id === id)?.status, 'expired')
  assert.throws(() => a.decide(id, true), /no approval/)
  assert.equal(payer.pays.length, 0)
})

test('two payments at once cannot both use one approval', async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 2 }, { approveAboveCkb: '0.5' })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example' })), 'needs_approval 403')
  a.decide(a.approvals()[0]!.id, true)
  const r = await Promise.all([code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example' })), code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example' }))])
  // The second is refused: for one request already on its way (it would pay twice), before it asks.
  assert.deepEqual(r.sort(), ['no error', 'payment_pending 409'])
  assert.equal(payer.pays.length, 1)
})

test('an approval does not lift the caps', async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 2, total_ckb: 1.5 }, { approveAboveCkb: '0.5' })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example' })), 'needs_approval 403')
  a.decide(a.approvals()[0]!.id, true)
  assert.equal((await a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example' })).status, 'paid')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example' })), 'over_cap 422', 'past the total, nothing asked of the person')
  assert.equal(a.status().waiting_approvals, 0)
  assert.equal(payer.pays.length, 1)
})

test('the person can stop every payment, and it stays stopped after a restart', async () => {
  const f = file()
  const { net, payer, a } = await agent({ per_payment_ckb: 1 }, { file: f })
  await a.pause(true)
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.1)).invoice })), 'paused 423')
  const again = await agent({ per_payment_ckb: 1 }, { file: f, payer })
  assert.equal(again.a.status().paused, true)
  assert.equal(await code(again.a.pay({ invoice: net.bill(ckb(0.1)).invoice })), 'paused 423')
  await again.a.pause(false)
  assert.equal((await again.a.pay({ invoice: net.bill(ckb(0.1)).invoice })).status, 'paid')
  assert.equal(payer.pays.length, 1)
})

test('invoices it cannot pay are refused before anything leaves', async () => {
  const { net, payer, a } = await agent()
  assert.equal(await code(a.pay({ invoice: net.bill(null).invoice })), 'invalid_invoice 400', 'no amount named')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1), { expired: true }).invoice })), 'expired 410')
  assert.equal(await code(a.pay({ invoice: 'fibt1unknown' })), 'invalid_invoice 400', 'not readable')
  assert.equal(await code(a.pay({ invoice: 'not an invoice' })), 'invalid_invoice 400')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(500)).invoice })), 'too_large 422', 'more than the balance')
  assert.equal(payer.pays.length, 0)
})

test('the same invoice twice is paid once; a failed one is not tried again', async () => {
  const { net, payer, a } = await agent()
  const b = net.bill(ckb(1))
  const first = await a.pay({ invoice: b.invoice })
  const again = await a.pay({ invoice: b.invoice })
  assert.equal(again.payment_hash, first.payment_hash)
  assert.equal(payer.pays.length, 1)
  payer.outcomes = ['failed']
  const c = net.bill(ckb(1))
  const failed = await a.pay({ invoice: c.invoice })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.preimage, null)
  assert.equal(a.status().spent_ckb, '1', 'a failed payment spends nothing')
  assert.equal(await code(a.pay({ invoice: c.invoice })), 'payment_failed 409')
  payer.refuse = 'no route to the payee'
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice })), 'payment_failed 502', 'refused by the LSP')
})

test('a payment slower than the wait answers "sending" and ends later', async () => {
  const { net, payer, a } = await agent({}, { waitMs: 50 })
  payer.outcomes = ['hang']
  const b = net.bill(ckb(1))
  const p = await a.pay({ invoice: b.invoice })
  assert.equal(p.status, 'sending')
  assert.equal(a.status().spent_ckb, '1', 'counted against the caps while on its way')
  payer.finish(b.hash)
  await until(() => a.get(b.hash)?.status === 'paid')
  assert.equal(a.get(b.hash)?.status, 'paid')
  assert.equal(a.get(b.hash)?.preimage, b.preimage)
})

test('a payment on its way when the process stopped is followed after a restart', async () => {
  const net = new FakeNet()
  const f = file()
  const payer = new FakePayer(net)
  payer.outcomes = ['hang']
  const first = await agent({}, { waitMs: 20, file: f, payer })
  const b = net.bill(ckb(1))
  assert.equal((await first.a.pay({ invoice: b.invoice })).status, 'sending')
  const second = await Agent.open({ session: payer, file: f })
  assert.equal(second.get(b.hash)?.status, 'sending')
  payer.finish(b.hash)
  await until(() => second.get(b.hash)?.status === 'paid')
  assert.equal(second.get(b.hash)?.status, 'paid')
  assert.equal(second.get(b.hash)?.preimage, b.preimage)
})

test('taking out closes the channel and sends the balance to the address set at start only', async () => {
  const swept: string[] = []
  const { net, payer, a } = await agent({}, { returnTo: 'ckt1qperson', sweep: async (to) => (swept.push(to), '0xswept') })
  await a.pay({ invoice: net.bill(ckb(1)).invoice })
  const t = await a.takeOut()
  assert.equal(t.status, 'closing')
  assert.equal(t.to, 'ckt1qperson')
  const done = await a.takenOut()
  assert.equal(done?.status, 'returned')
  assert.equal(done?.tx, '0xswept')
  assert.deepEqual(swept, ['ckt1qperson'])
  assert.ok(payer.state.channel?.closed)
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice })), 'not_ready 503', 'nothing paid once taken out')
  // Control: no address set, the money stays at the agent's own address.
  const own = await agent()
  await own.a.takeOut()
  assert.equal((await own.a.takenOut())?.status, 'closed')
})

// A seller can hold a payment on its way for days, and with it the person's take-out. Asked then, the take-out waits for it, lets no new payment start, and closes by
// itself once it ends.
test('taking out waits for a payment on its way, starts no other, and closes once it ends', async () => {
  const { net, payer, a } = await agent({}, { waitMs: 20, returnTo: 'ckt1qperson', sweep: async () => '0xswept' })
  payer.outcomes = ['hang']
  const b = net.bill(ckb(1))
  await a.pay({ invoice: b.invoice })
  assert.equal((await a.takeOut()).status, 'waiting')
  assert.equal((await a.takeOut()).status, 'waiting', 'asked again, the same')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.1)).invoice })), 'not_ready 503', 'no new payment while it waits')
  assert.equal(payer.pays.length, 1)
  payer.finish(b.hash)
  // The close is looked at every 2 s: on a slower machine (CI) the second look is past 2 s.
  await until(() => a.status().take_out?.status === 'returned', 6_000)
  assert.equal(a.get(b.hash)?.status, 'paid')
  assert.equal(a.status().take_out?.status, 'returned', 'closed and sent on by itself once the payment ended')
  assert.equal(a.status().take_out?.to, 'ckt1qperson')
})

test('a payment the session never wrote down ends failed at the next start, and holds no take-out back', async () => {
  const f = file()
  const first = await agent({}, { file: f, waitMs: 20 })
  first.payer.outcomes = ['hang']
  const b = first.net.bill(ckb(1))
  await first.a.pay({ invoice: b.invoice })
  // As if the agent stopped after writing it and before the session did: a new session knows nothing of it.
  const next = await agent({}, { file: f, waitMs: 20, returnTo: 'ckt1qperson', sweep: async () => '0xswept' })
  await until(() => next.a.get(b.hash)?.status === 'failed')
  assert.match(next.a.get(b.hash)?.error ?? '', /not sent: the agent stopped before handing it to the channel/)
  assert.equal(next.a.status().spent_ckb, '0', 'not counted against the caps')
  assert.equal((await next.a.takeOut()).status, 'closing')
  // Control: one the session did write down is followed, not ended.
  const kept = await agent({}, { waitMs: 20 })
  kept.payer.outcomes = ['hang']
  const k = kept.net.bill(ckb(1))
  await kept.a.pay({ invoice: k.invoice })
  const again = await agent({}, { file: (kept.a as any).o.file, payer: kept.payer, waitMs: 20 })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(again.a.get(k.hash)?.status, 'sending')
})

// The sweep sends what the indexer shows then; a close seen late leaves the rest at the agent's
// address, which a "returned" take-out never looked at again (2026-11-01).
test('what reaches the agent address after a take-out is sent on: by itself shortly after, or when asked again', async () => {
  let held = 0n
  const sweeps: string[] = []
  const sweep = async (to: string) => {
    sweeps.push(to)
    held = 0n
    return `0xsweep${sweeps.length}`
  }
  const { payer, a } = await agent({}, { returnTo: 'ckt1qperson', sweep, balance: async () => held, sweepAgainMs: 30 })
  await a.takeOut()
  await until(() => a.status().take_out?.status === 'returned')
  held = 150n * SHANNONS // the channel's share, seen by the indexer only now
  await until(() => sweeps.length === 2)
  assert.deepEqual(sweeps, ['ckt1qperson', 'ckt1qperson'])
  await a.takenOut()
  assert.deepEqual(a.status().take_out?.later, ['0xsweep2'])
  // Asked again later, with something there: sent on; with nothing (or less than a cell), not.
  ;(payer.state.channel as any).ready = false
  held = 100n * SHANNONS
  await a.takeOut()
  await a.takenOut()
  assert.equal(sweeps.length, 3)
  held = 61n * SHANNONS
  assert.equal((await a.takeOut()).status, 'returned')
  await a.takenOut()
  assert.equal(sweeps.length, 3, 'control: too little for a cell of its own is left')
})

// An earlier channel's take-out was shown as this one's, so the pages hid the take-out of a channel
// opened since (2026-11-01, seen on the phone page).
test("after a take-out, a channel opened since shows none, and can be taken out in its turn", async () => {
  const { payer, a } = await agent({}, { returnTo: 'ckt1qperson', sweep: async () => '0xswept' })
  await a.takeOut()
  await a.takenOut()
  assert.equal(a.status().take_out?.status, 'returned', 'the closed channel: taken out')
  payer.state.channelId = '0xc2'
  payer.state.channel = { ready: true, closed: false, local: 20n * SHANNONS, remote: 0n }
  assert.equal(a.status().take_out, null, 'the new channel: nothing taken out')
  assert.equal((await a.takeOut()).status, 'closing')
})

test("a closed channel's balance is sent on by a take-out: after a sweep that failed, or a close by the LSP", async () => {
  let fails = 1
  const sweeps: string[] = []
  const { payer, a } = await agent({}, { returnTo: 'ckt1qperson', sweep: async (to) => (sweeps.push(to), fails-- > 0 ? Promise.reject(new Error('the indexer is behind')) : '0xswept') })
  await a.takeOut()
  assert.equal((await a.takenOut())?.status, 'failed')
  ;(payer.state.channel as any).ready = false
  assert.equal((await a.takeOut()).status, 'closed', 'asked again: sent on again')
  assert.equal((await a.takenOut())?.status, 'returned')
  assert.deepEqual(sweeps, ['ckt1qperson', 'ckt1qperson'])
  // Closed by the LSP, no take-out asked: one sends it on.
  const lsp = await agent({}, { returnTo: 'ckt1qperson', sweep: async () => '0xswept' })
  ;(lsp.payer.state.channel as any).closed = true
  ;(lsp.payer.state.channel as any).ready = false
  assert.equal((await lsp.a.takeOut()).status, 'closed')
  assert.equal((await lsp.a.takenOut())?.status, 'returned')
})

test('a channel that does not close in time is said, and can be taken out again', async () => {
  const { payer, a } = await agent()
  payer.closes = false
  await a.takeOut()
  const t = await a.takenOut()
  assert.equal(t?.status, 'failed')
  assert.match(t?.error ?? '', /did not close/)
  payer.closes = true
  payer.state.closing = false
  assert.equal((await a.takeOut()).status, 'closing')
  assert.equal((await a.takenOut())?.status, 'closed')
})

test('a new channel after a take-out pays again', async () => {
  const { net, payer, a } = await agent()
  await a.takeOut()
  await a.takenOut()
  payer.state.channelId = '0xc2'
  payer.state.channel = { ready: true, closed: false, local: 50n * SHANNONS, remote: 50n * SHANNONS }
  assert.equal((await a.pay({ invoice: net.bill(ckb(1)).invoice })).status, 'paid')
})

test('an answer lost after the payment was recorded is followed, not called failed', async () => {
  const { net, payer, a } = await agent()
  payer.lose = `Unexpected token '<', "<html>" is not valid JSON`
  const b = net.bill(ckb(0.5))
  const p = await a.pay({ invoice: b.invoice })
  assert.equal(p.status, 'paid', 'it went, and its end was heard')
  assert.equal(p.preimage, b.preimage)
  // Control: refused before anything was recorded, it is failed.
  payer.refuse = `Unexpected token '<', "<html>" is not valid JSON`
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.5)).invoice })), 'payment_failed 502')
})

// The money path, each case with its control.

test('a take-out stopped by a restart while closing, or closed, is carried on, to the address set now', async () => {
  for (const status of ['closing', 'closed'] as const) {
    const f = file()
    // As the agent left it: the take-out under way, to the address of an earlier start.
    writeFileSync(f, JSON.stringify({ payments: [], take_out: { status, channel: '0xc1', to: 'ckt1qold', tx: null, error: null, at: Date.now() } }))
    const net = new FakeNet()
    const payer = new FakePayer(net)
    ;(payer.state.channel as any).closed = true
    ;(payer.state.channel as any).ready = false
    const sweeps: string[] = []
    const { a } = await agent({}, { file: f, payer, returnTo: 'ckt1qperson', sweep: async (to) => (sweeps.push(to), '0xswept') })
    await until(() => a.status().take_out?.status === 'returned')
    assert.equal(a.status().take_out?.status, 'returned', `${status}: carried on at the start`)
    assert.deepEqual(sweeps, ['ckt1qperson'], `${status}: to the address set now`)
    assert.equal((await a.takeOut()).status, 'returned', 'asked again: as it stands')
  }
})

test('a second payment for a request already on its way is refused, so one thing is not paid twice', async () => {
  const { net, payer, a } = await agent({}, { waitMs: 20 })
  payer.outcomes = ['hang']
  const first = net.bill(ckb(0.3))
  await a.pay({ invoice: first.invoice, seller: 's.example', memo: 'GET s.example/v1/report' })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.3)).invoice, seller: 's.example', memo: 'GET s.example/v1/report' })), 'payment_pending 409')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.3)).invoice, seller: 's.example', memo: 'GET s.example/v1/other' })), 'no error', 'control: another request goes')
  payer.finish(first.hash)
  await until(() => a.get(first.hash)?.status === 'paid')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(0.3)).invoice, seller: 's.example', memo: 'GET s.example/v1/report' })), 'no error', 'once it has ended, it can be bought again')
})

test('an approval is for what was bought: another request to the same seller is asked for again', async () => {
  const { net, payer, a } = await agent({ per_payment_ckb: 2 }, { approveAboveCkb: '0.5' })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example', memo: 'GET s.example/v1/report/alice' })), 'needs_approval 403')
  a.decide(a.approvals()[0]!.id, true)
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example', memo: 'POST s.example/v1/transfer/alice' })), 'needs_approval 403', 'not on the approval for the report')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example', memo: 'GET s.example/v1/report/alice' })), 'no error', 'control: the report itself')
  assert.equal(payer.pays.length, 1)
})

test('new asks never push out a refusal that stands, nor a payment still waiting', async () => {
  const { net, a } = await agent({ per_payment_ckb: 2 }, { approveAboveCkb: '0.5' })
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example', memo: 'GET s.example/refused' })), 'needs_approval 403')
  a.decide(a.approvals()[0]!.id, false)
  let last = ''
  for (let i = 0; i < 60; i++) last = await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example', memo: `GET s.example/${i}` }))
  assert.equal(last, 'too_many_waiting 429', 'past what is kept, nothing more is asked')
  assert.equal(await code(a.pay({ invoice: net.bill(ckb(1)).invoice, seller: 's.example', memo: 'GET s.example/refused' })), 'refused_by_person 403', 'the refusal stands')
})
