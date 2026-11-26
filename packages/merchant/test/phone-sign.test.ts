// The words the person signs on their phone, and the check that a signature is theirs: real
// signatures by a CKB key, as a wallet makes them, with the controls that must fail.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ccc } from '@ckb-ccc/core'
import { askMessages, commandMessage, readCommand, signedBy, COMMAND_WINDOW_MS } from '../src/phone-sign.ts'

const client = new ccc.ClientPublicTestnet()
const AGENT = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqt5d97mu8h66t9h9y0ys02p8deqcczfm0gqtst4v'
const person = new ccc.SignerCkbPrivateKey(client, '0x' + '11'.repeat(32))
const stranger = new ccc.SignerCkbPrivateKey(client, '0x' + '22'.repeat(32))
const NOW = Date.parse('2026-11-01T17:30:05Z')
const ask = { id: '3f2a9c01b2d4', amount_ckb: '1', seller: 'fiber-names-api.lusocryptolabs.com', payee: '02' + 'cd'.repeat(32), memo: 'POST fiber-names-api.lusocryptolabs.com/v1/bundle', expires_at: NOW + 600_000 }
const sigOf = async (s: ccc.SignerCkbPrivateKey, m: string) => {
  const x = await s.signMessage(m)
  return { signature: x.signature, identity: x.identity, signType: x.signType }
}

test('the words of an approval say what is approved, and approving differs from refusing in its first line only', () => {
  const m = askMessages(AGENT, ask)
  assert.equal(
    m.approve,
    [
      'Cellula agent: approve this payment',
      `Agent: ${AGENT}`,
      'Amount: 1 CKB',
      'To: fiber-names-api.lusocryptolabs.com',
      'For: POST fiber-names-api.lusocryptolabs.com/v1/bundle',
      'Approval: 3f2a9c01b2d4, open until 2026-11-01T17:40:05Z',
    ].join('\n'),
  )
  assert.equal(m.refuse.split('\n')[0], 'Cellula agent: refuse this payment')
  assert.deepEqual(m.refuse.split('\n').slice(1), m.approve.split('\n').slice(1))
  // A memo the agent was handed cannot add a line of its own.
  const forged = askMessages(AGENT, { ...ask, memo: 'a report\nAmount: 0.01 CKB x' })
  assert.equal(forged.approve.split('\n').length, 6)
  assert.match(forged.approve, /^For: a report Amount: 0\.01 CKB x$/m)
  assert.match(askMessages(AGENT, { ...ask, seller: null }).approve, new RegExp(`^To: the payee ${ask.payee}$`, 'm'))
})

test('a command is read back only as written: this agent, one of three, a take-out to its own address, in time', () => {
  const nonce = '9f8e7d6c5b4a3210'
  const stop = commandMessage(AGENT, 'stop', NOW, nonce)
  assert.equal(stop, ['Cellula agent: stop every payment', `Agent: ${AGENT}`, 'Asked: 2026-11-01T17:30:05Z, 9f8e7d6c5b4a3210'].join('\n'))
  assert.deepEqual(readCommand(AGENT, null, stop, NOW), { command: 'stop', atMs: NOW, nonce, stop: null })
  const resume = commandMessage(AGENT, 'resume', NOW, nonce, undefined, '00112233aabbccdd')
  assert.equal(resume.split('\n')[2], 'Undoes stop: 00112233aabbccdd', 'a go-again names the stop it undoes')
  assert.deepEqual(readCommand(AGENT, null, resume, NOW + 60_000), { command: 'resume', atMs: NOW, nonce, stop: '00112233aabbccdd' })
  assert.equal(readCommand(AGENT, null, commandMessage(AGENT, 'resume', NOW, nonce), NOW), null, 'a go-again that names no stop')
  const out = commandMessage(AGENT, 'take-out', NOW, nonce, 'ckt1qperson')
  assert.equal(readCommand(AGENT, 'ckt1qperson', out, NOW)?.command, 'take-out')
  // Controls: each of these is refused.
  assert.equal(readCommand('ckt1qother', null, stop, NOW), null, "another agent's")
  assert.equal(readCommand(AGENT, 'ckt1qperson', commandMessage(AGENT, 'take-out', NOW, nonce, 'ckt1qthief'), NOW), null, 'a take-out to another address')
  assert.equal(readCommand(AGENT, null, out, NOW), null, 'a take-out to an agent with no return address')
  assert.equal(readCommand(AGENT, null, stop, NOW + COMMAND_WINDOW_MS + 1000), null, 'too old')
  assert.equal(readCommand(AGENT, null, stop, NOW - COMMAND_WINDOW_MS - 1000), null, 'from the future')
  assert.equal(readCommand(AGENT, null, stop.replace(nonce, 'xyz'), NOW), null, 'no nonce')
  assert.equal(readCommand(AGENT, null, `${stop}\nAnd send all of it elsewhere`, NOW), null, 'a line more')
  assert.equal(readCommand(AGENT, null, stop.replace('stop every payment', 'pay everything'), NOW), null, 'no such command')
})

test("a signature counts only by a key of the person's wallet, over the exact words", async () => {
  const words = askMessages(AGENT, ask).approve
  const mine = await person.getRecommendedAddress()
  const good = await sigOf(person, words)
  assert.equal(await signedBy(client, words, good, mine), true)
  // Controls.
  assert.equal(await signedBy(client, words.replace('Amount: 1 CKB', 'Amount: 9 CKB'), good, mine), false, 'other words')
  assert.equal(await signedBy(client, words, await sigOf(stranger, words), mine), false, 'another key')
  assert.equal(await signedBy(client, words, good, await stranger.getRecommendedAddress()), false, 'another address')
  assert.equal(await signedBy(client, askMessages(AGENT, ask).refuse, good, mine), false, 'an approval read as a refusal')
  assert.equal(await signedBy(client, words, { ...good, signature: '0x' + '00'.repeat(65) }, mine), false, 'a broken signature')
  assert.equal(await signedBy(client, words, { ...good, signType: 'Nonsense' }, mine), false, 'a sign type nobody knows')
  assert.equal(await signedBy(client, words, null as never, mine), false, 'nothing')
})

test('the words keep what names a seller: no hidden or reordering characters, a long host by its end, a cut marked', () => {
  const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.attacker-owned.example`
  const sly = String.fromCharCode(0x202e, 0x200b, 0x85, 0xad, 0x2066)
  const w = askMessages(AGENT, { ...ask, seller: host, memo: `GET ${sly}https://${host}/${'p'.repeat(200)}` }).approve
  const to = w.split('\n').find((l) => l.startsWith('To: '))!
  const forLine = w.split('\n').find((l) => l.startsWith('For: '))!
  assert.equal(to, `To: ${host}`, 'a whole host, however long a DNS name can be')
  assert.ok(!/[\u0080-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(w), 'nothing hidden or reordering')
  assert.ok(forLine.endsWith('...') && forLine.length <= 'For: '.length + 160, 'a long memo cut, and the cut shown')
  const long = askMessages(AGENT, { ...ask, seller: `${'x'.repeat(300)}.attacker-owned.example` }).approve.split('\n').find((l) => l.startsWith('To: '))!
  assert.ok(long.startsWith('To: ...') && long.endsWith('.attacker-owned.example'), 'past 260 characters, a host keeps its end')
})
