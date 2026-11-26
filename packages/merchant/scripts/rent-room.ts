// Rent room to receive from the LSP for a Fiber node of your own, without
// the rest of the kit: the node pays the LSP's invoice and opens a second channel that gets the room.
//
//   node scripts/rent-room.ts --terms
//   node scripts/rent-room.ts --node http://127.0.0.1:8227 --room 5000 [--months 1] [--open 109]
//   node scripts/rent-room.ts --status <payment hash>
//
// --gateway (LSP3 on testnet unless told), --lsp (the LSP node's key), --token (the node's RPC
// Biscuit, when it asks for one), --no-open (pay only; open the channel yourself). Renew with the
// same command before the rent ends: a rent paid while one runs starts at its end. When it ends,
// the LSP funds the default again and, a week later, closes the channel the rent paid for.

import { ownNodeRoom, statusAt, termsAt } from '../src/room.ts'
import { NodeSession } from '../src/node-session.ts'
import { LAB_GATEWAY, LSP3_PUBKEY } from '../src/lsp3.ts'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const gateway = flag('gateway') ?? LAB_GATEWAY
const ckb = (shannons: bigint) => (Number(shannons) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })
const date = (ms: number | null) => (ms == null ? 'not yet' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC')

async function main() {
  if (args.includes('--terms')) {
    const t = await termsAt(gateway)
    if (!t) return console.log('This LSP rents no room.')
    return console.log(`${t.perMonth * 100}% of the room per ${t.monthMs / 86_400_000} days, from ${ckb(t.least)} to ${ckb(t.most)} CKB of room.`)
  }
  const hash = flag('status')
  if (hash) {
    const r = await statusAt(gateway, hash)
    return console.log(`${ckb(r.room)} CKB of room, ${r.paid ? `paid, from ${date(r.start)} until ${date(r.until)}` : 'not paid'}${r.ended ? ', ended' : ''}${r.closed ? ', its channel closed' : ''}.`)
  }
  const url = flag('node')
  const room = Number(flag('room'))
  if (!url || !(room > 0)) {
    console.error('usage: --node <rpc url> --room <ckb> [--months n] [--open ckb] [--no-open] | --status <hash> | --terms')
    process.exit(2)
  }
  const node = new NodeSession({ url, token: flag('token') })
  const rail = ownNodeRoom({ gateway, lspPubkey: flag('lsp') ?? LSP3_PUBKEY, node, openCkb: flag('open') ? Number(flag('open')) : undefined })
  const terms = await rail.terms()
  if (!terms) throw new Error('this LSP rents no room')
  console.log(`Renting ${room} CKB of room for ${Number(flag('months') ?? 1)} x ${terms.monthMs / 86_400_000} days from ${gateway}; the node pays the LSP's invoice.`)
  const rent = await rail.rent(BigInt(Math.round(room * 1e8)), Number(flag('months') ?? 1))
  console.log(`Rent ${rent.paymentHash}: ${ckb(rent.price)} CKB, ${rent.paid ? `paid, until ${date(rent.until)}` : 'not seen paid yet (ask again with --status)'}.`)
  if (!rent.paid || args.includes('--no-open')) return
  // A renewal starts at the end of the rent running now: its channel keeps the room.
  if ((rent.start ?? 0) > Date.now() + 60_000) return console.log(`It follows the rent running now, from ${date(rent.start)}: the channel it paid for keeps the room.`)
  await rail.place()
  console.log(`A new channel to the LSP is opening; it gets ${room} CKB of room. Renew before ${date(rent.until)}.`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
