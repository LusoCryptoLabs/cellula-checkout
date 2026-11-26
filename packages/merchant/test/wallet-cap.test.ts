// LSP2's cap of Fiber balances per wallet (since 2026-10-27: at most 2
// open at once). A shop's key at the cap must not start a channel, and its log must say why: the
// session reads the cap from /capacity?wallet= and refuses before anything is asked of the LSP.
// An older copy of the session read only can_open and said "The LSP has no room".
// The opening here is the one startMerchant makes, with the kit's own LSP2 config.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { ccc } from '@ckb-ccc/core'

// The session is more than Node strips: bundled, as scripts/build.mjs does.
const here = fileURLToPath(new URL('./', import.meta.url))
const out = path.join(here, '.wallet-cap.bundle.mjs')
await build({
  stdin: {
    contents: "export { lsp3Testnet, LAB_GATEWAY } from '../src/start.ts'\nexport { FiberSession } from '../../../vendor/fiber-session/index.ts'\nexport { nodeHost } from '../../../vendor/fiber-session/node.ts'",
    resolveDir: here,
    loader: 'ts',
  },
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['@ckb-ccc/core', './signer/*'],
  logLevel: 'silent',
})
const { lsp3Testnet, LAB_GATEWAY, FiberSession, nodeHost } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

// As LSP2's gateway answers /capacity?wallet=.
const AT_CAP = { channels_left: 40, can_open: false, opening_fee: 0, room: 200e8, free_room_full: false, wallet_open: 2, wallet_most: 2, code: 'wallet_cap', wallet_channels: [{ opened: 1761500000, funded: 13_900_000_000 }, { opened: 1761600000, funded: null }] }
const UNKNOWN = { channels_left: 40, can_open: false, opening_fee: 0, room: 200e8, free_room_full: false, wallet_open: null, wallet_most: 2, code: 'wallet_cap_unknown', wallet_channels: [] }
const NO_ROOM = { channels_left: 0, can_open: false, opening_fee: 0, room: 200e8, free_room_full: false, wallet_open: 0, wallet_most: 2 }

const realFetch = globalThis.fetch

async function shopOpening(answer: unknown) {
  const asked: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url instanceof Request ? url.url : url))
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'merchant-cap-')), 'channel.json')
  const session = new FiberSession(nodeHost({ file, restart: () => {} }), lsp3Testnet())
  const wallet = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), '0x' + '01'.repeat(32))
  const lock = (await wallet.getRecommendedAddressObj()).script
  let said = ''
  try {
    await session.open(wallet, 10n)
    said = 'opened'
  } catch (e) {
    said = e instanceof Error ? e.message : String(e)
  } finally {
    globalThis.fetch = realFetch
  }
  return { said, asked, wallet: `${lock.codeHash}:${lock.hashType}:${lock.args}`, written: existsSync(file) }
}

test("a shop's key at the cap is told so, and nothing is asked of the LSP", async () => {
  const r = await shopOpening(AT_CAP)
  assert.equal(r.said, 'Your wallet has 2 channels open at the LSP, the most a wallet may have, so nothing was asked of it. Close one to open another.')
  assert.deepEqual(r.asked, [`${LAB_GATEWAY}/capacity?wallet=${encodeURIComponent(r.wallet)}`], 'only the terms were read')
  assert.equal(r.written, false, 'no signer started, no channel file')
})

test('a cap the LSP could not count is said as such', async () => {
  const r = await shopOpening(UNKNOWN)
  assert.equal(r.said, 'How many channels your wallet has open at the LSP could not be read just now, so nothing was asked of it. Try again in a moment.')
  assert.equal(r.asked.length, 1)
})

test('control: no room for anyone is still said as no room', async () => {
  const r = await shopOpening(NO_ROOM)
  assert.match(r.said, /^The LSP has no room for a new channel right now/)
  assert.equal(r.asked.length, 1)
})
