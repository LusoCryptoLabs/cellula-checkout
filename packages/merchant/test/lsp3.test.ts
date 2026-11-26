import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHANNEL_FILE, LAB_GATEWAY, LSP3_NODE, lsp3Ready, RESERVE_CKB } from '../src/lsp3.ts'

// The kit on the LSP3 line: the v3 signer refuses a channel of the LSP2 line, so the kit keeps its
// channel under a name of its own, and LSP3 has only the full payment hash layout (100 CKB reserve).
test('the kit is on the LSP3 line: its gateway, its reserve and its channel file', () => {
  assert.match(LAB_GATEWAY, /\/lsp3$/)
  assert.equal(RESERVE_CKB, 100)
  assert.equal(CHANNEL_FILE, 'channel3.json')
})

test("nothing starts while LSP3's node is not named", () => {
  const was = { ...LSP3_NODE }
  try {
    Object.assign(LSP3_NODE, { pubkey: '', shutdownArgs: '' })
    assert.throws(() => lsp3Ready(), /LSP3's node is not named yet/)
    Object.assign(LSP3_NODE, { pubkey: '02' + '11'.repeat(32), shutdownArgs: '' })
    assert.throws(() => lsp3Ready(), /not named yet/)
    Object.assign(LSP3_NODE, { pubkey: '02' + '11'.repeat(32), shutdownArgs: '0x' + '22'.repeat(20) })
    assert.doesNotThrow(() => lsp3Ready())
  } finally {
    Object.assign(LSP3_NODE, was)
  }
})
