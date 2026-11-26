// Rented room for a hosted shop, end to end on testnet, with LSP2's
// gateway renting room (its RENT_PER_MONTH on for the drill). Run it until it says done: the first
// run opens a channel, rents 2,000 CKB of room, pays it from the channel and takes the channel out,
// ending the process with 75 as a server's restart does; the second run moves the rent to the new
// tenant and opens a channel that gets the room; then it takes that one out too.
//
//   node scripts/build.mjs room && DRILL_KEY=<file> DRILL_DIR=<dir> node dist-room/room-drill.mjs
//   (again while it exits with 75)

import { readFileSync } from 'node:fs'
import { startMerchant } from '../src/start.ts'

const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const dir = process.env.DRILL_DIR ?? './room-drill'
const key = readFileSync(process.env.DRILL_KEY ?? '', 'utf8').trim()
const ROOM = 2000

let bad = 0
const ok = (v: boolean, what: string, d = '') => {
  if (!v) bad++
  say(`${v ? 'ok  ' : 'FAIL'} ${what}${d ? ': ' + d : ''}`)
}

const { merchant, session } = await startMerchant({ dir, key, openCkb: 40, roomPlace: 'manual', log: (l) => say(l) })
const rents = merchant.rents()
const status = merchant.status()
say('status:', JSON.stringify(status), '| rents:', rents.map((r) => `${r.payment_hash.slice(0, 10)} ${r.room_ckb} ${r.status}`).join(', ') || 'none')

if (!rents.length) {
  const terms = await merchant.roomTerms()
  ok(!!terms && terms.per_month === 0.01, 'the LSP rents room at 1% a month', JSON.stringify(terms))
  ok(Number(status.can_receive_ckb) < ROOM, `before: the channel takes in less than ${ROOM} CKB`, status.can_receive_ckb)
  const rent = await merchant.rentRoom({ room_ckb: ROOM, months: 1 })
  ok(rent.status === 'waiting' && rent.price_ckb === '20', 'rented and paid from the channel: 20 CKB, waiting for a channel', JSON.stringify(rent))
  say('taking the channel out to bring the room in; this process ends with 75 on the way')
  await merchant.placeRoom()
  // Not reached when the session started again (exit 75).
  ok(false, 'the process should have started again')
} else {
  const rent = rents[0]!
  ok(rent.status === 'running', 'after the new start the rent moved to this channel', rent.status)
  ok(Number(status.can_receive_ckb) >= ROOM, `the new channel takes in ${ROOM} CKB or more`, status.can_receive_ckb)
  // Leave nothing behind: take this channel out too.
  await session.close()
  for (let i = 0; i < 240 && !session.state.channel?.closed; i++) await new Promise((r) => setTimeout(r, 2500))
  ok(!!session.state.channel?.closed, 'taken out at the end')
  say(bad ? `${bad} FAILED` : 'done: all ok')
  process.exit(bad ? 1 : 0)
}
