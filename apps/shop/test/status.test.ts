// What the shop's page is told (src/status.ts). After a failed opening fee at start the page said
// "Closed for now" and stopped asking, though the merchant pays the fee again a minute later: it now
// hears "starting" while the channel waits for its fee, and keeps asking until the shop is open.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shopStatus } from '../src/status.ts'

const merchant = (ready: boolean, waitsForFee: boolean) => ({
  status: () => ({ ready, can_receive_ckb: ready ? '200' : '0', balance_ckb: '10' }),
  waitsForFee: () => waitsForFee,
})

test('a channel waiting for its opening fee is getting ready, not closed', () => {
  assert.deepEqual(shopStatus(merchant(false, true), ''), { ready: false, can_receive_ckb: '0', balance_ckb: '10', starting: true })
})

test('open once the fee is paid', () => {
  assert.deepEqual(shopStatus(merchant(true, false), ''), { ready: true, can_receive_ckb: '200', balance_ckb: '10', starting: false })
})

test('controls: still starting, did not start, a channel taken out', () => {
  assert.deepEqual(shopStatus(null, ''), { ready: false, starting: true, error: undefined })
  assert.deepEqual(shopStatus(null, 'no key at /etc/fiber-shop.key'), { ready: false, starting: false, error: 'no key at /etc/fiber-shop.key' })
  assert.equal(shopStatus(merchant(false, false), '').starting, false, 'closed, no fee to wait for: closed for now')
})
