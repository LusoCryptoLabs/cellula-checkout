// A payer on LSP3, as a Cellula wallet's quick balance is (a FiberSession tenant, its own signer):
// it tops up 20 CKB, pays one invoice and takes the rest back at once, the take-back that got stuck
// on 2026-10-12 (docs/OWN-NODE.md). Two more modes on a saved run:
// `close` takes the rest back, `inspect` prints the tenant's own view of its channel, the request it
// waits on and what its signer says of it.
//   node scripts/build.mjs payer
//   node dist-payer/payer.mjs <keys file> <run dir> <invoice | close | inspect>
// The keys file holds two testnet keys, the payer second; it is never in the repository.
import path from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { ccc } from '@ckb-ccc/core'
import { FiberSession } from '../../../vendor/fiber-session/index.ts'
import { nodeHost } from '../../../vendor/fiber-session/node.ts'
import { lsp3Testnet } from '../src/start.ts'

const [keysFile, dir, invoice] = process.argv.slice(2)
if (!keysFile || !dir || !invoice) {
  console.error('usage: payer.mjs <keys file> <run dir> <invoice | close | inspect>')
  process.exit(2)
}
const t0 = Date.now()
const say = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const within = <T,>(p: Promise<T>, ms: number, what: string) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer in ${ms / 1000} s`)))])

const kPayer = readFileSync(keysFile, 'utf8').split(/\s+/).filter(Boolean)[1]
if (!kPayer) throw new Error('the keys file must hold two keys, the payer second')
mkdirSync(dir, { recursive: true })
const client = new ccc.ClientPublicTestnet({ url: 'https://testnet.ckb.dev/' })
const wallet = new ccc.SignerCkbPrivateKey(client, `0x${kPayer}`)
const payer = new FiberSession(nodeHost({ file: path.join(dir, 'payer3.json'), restart: () => say('the session asked to start again') }), {
  ...lsp3Testnet(),
  ownerKey: (h) => `proof-outside-payer:${h}`,
  lockName: 'proof-outside:payer',
})
try {
  await payer.start()
  if (invoice === 'inspect') {
    for (let i = 0; i < 60 && !payer.state.channel; i++) await sleep(1000)
    const lsp = (m: string, p: unknown) => (payer as any).lsp(m, p).catch((e: Error) => ({ error: e.message }))
    const id = payer.state.channelId
    const show = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'string' && v.length > 40 ? v.slice(0, 18) + '…' : v))
    for (let round = 0; round < 2; round++) {
      const ch = await lsp('list_channels', { include_closed: true })
      for (const c of ch.channels ?? []) say('tenant view', c.channel_id?.slice(0, 12), show(c.state), 'pending', show(c.pending_tlcs))
      say('signing status', show(await lsp('get_channel_signing_status', { channel_id: id })))
      say('payments', show(await lsp('list_payments', {})))
      say('session', payer.state.phase, payer.state.status)
      try { say('signer poll', await (payer as any).signer.poll()) } catch (e) { say('signer poll threw', e instanceof Error ? e.message : String(e)) }
      await sleep(20_000)
    }
    process.exit(0)
  }
  if (invoice === 'close') {
    for (let i = 0; i < 60 && !payer.state.channel; i++) await sleep(1000)
    say('channel', payer.state.channel?.stateName, payer.state.status)
    throw new Error('resuming only to take the rest back')
  }
  await within(payer.open(wallet, 20n), 5 * 60_000, 'opening')
  await within(payer.whenReady(), 10 * 60_000, 'ready')
  say('payer ready with', ccc.fixedPointToString(payer.state.channel?.local ?? 0n), 'CKB')
  const t1 = Date.now()
  let hash = ''
  try {
    hash = await payer.pay(invoice)
    say('sent', hash.slice(0, 12))
    const paid = await within(payer.whenSent(hash), 3 * 60_000, 'paid')
    say(paid ? 'PAID' : 'NOT PAID', `${((Date.now() - t1) / 1000).toFixed(1)} s`)
  } catch (e) {
    say('PAY FAILED:', e instanceof Error ? e.message : String(e))
  }
} catch (e) {
  say('ERROR:', e instanceof Error ? e.message : String(e))
} finally {
  if (payer.state.channel && !payer.state.channel.closed) {
    say('taking the rest back')
    await payer.close().catch((e) => say('close:', String(e)))
    for (let i = 0; i < 240 && !payer.state.channel?.closed; i++) await sleep(2000)
    say(payer.state.channel?.closed ? 'closed' : 'still closing', payer.state.status)
  }
  process.exit(0)
}
