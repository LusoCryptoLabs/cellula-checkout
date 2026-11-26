// What the person signs on their phone with their wallet (the Cellula wallet, or any CKB wallet that
// signs messages), and how a signature is checked to be theirs. The words are what the wallet shows before it signs, so
// they say plainly what is approved; the agent checks a signature against the exact words it wrote
// itself, and against the person's address fixed when it started, never against what a relay or a
// page says.
//
// The first line, "Cellula agent: ...", keeps these apart from a sign-in (JSON, "cells.login.v1") and
// a payment request (JSON, {"v":1}): a signature made for one can never be read as another.

import { createHash } from 'node:crypto'
import { ccc } from '@ckb-ccc/core'
import { ACCOUNT_SIGN_TYPE, PQ_SIGN_TYPE, joyIdSignatureIsHonest, locksForIdentity, pqVerifyMessage, verifyAccountMessage } from 'cellula-sdk'

export type WalletSignature = { signature: string; identity: string; signType: string }

/** What an approval is about, as the agent's approvals list keeps it. */
export type AskFacts = { id: string; amount_ckb: string; seller: string | null; payee: string | null; memo: string; expires_at: number }

export type Command = 'stop' | 'resume' | 'take-out'

const COMMAND_LINE: Record<Command, string> = {
  stop: 'stop every payment',
  resume: 'let it pay again',
  'take-out': 'take its balance out',
}

/** A command is good for this long either side of the agent's clock. */
export const COMMAND_WINDOW_MS = 10 * 60_000

// A seller's text, or a memo the agent was handed, on one line and short: it is read by a person, and
// must not pass for one of the lines below it. Characters that move or hide text (C1 controls, bidi
// overrides, zero-width ones) go; a cut is marked, and a host keeps its end, the part that names it.
const oneLine = (s: string, most: number, keep: 'start' | 'end' = 'start') => {
  const t = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (t.length <= most) return t
  return keep === 'end' ? `...${t.slice(t.length - most + 3)}` : `${t.slice(0, most - 3)}...`
}

/** The token in the person's link, made from the agent's secret: a relay takes a new token only from
 * the agent that holds its secret, so one who learns the link cannot claim it first. */
export const phoneToken = (secret: string) => createHash('sha256').update(`cellula agent relay token\n${secret}`).digest('hex').slice(0, 32)

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The words to approve, and to refuse, one waiting payment. */
export function askMessages(agent: string, a: AskFacts): { approve: string; refuse: string } {
  const to = a.seller ?? (a.payee ? `the payee ${a.payee}` : 'an invoice given as is')
  const body = [`Agent: ${agent}`, `Amount: ${a.amount_ckb} CKB`, `To: ${oneLine(to, 260, 'end')}`, ...(a.memo ? [`For: ${oneLine(a.memo, 160)}`] : []), `Approval: ${a.id}, open until ${iso(a.expires_at)}`]
  return { approve: ['Cellula agent: approve this payment', ...body].join('\n'), refuse: ['Cellula agent: refuse this payment', ...body].join('\n') }
}

/**
 * The words of a command from the person's phone. `to` is the agent's return address, for a
 * take-out; `stop` is the stop a go-again undoes (the agent's `paused_id`), so one signed before a
 * later stop, held back by a relay and passed on after it, undoes nothing: no clock decides it.
 */
export function commandMessage(agent: string, command: Command, atMs: number, nonce: string, to?: string, stop?: string): string {
  return [
    `Cellula agent: ${COMMAND_LINE[command]}`,
    `Agent: ${agent}`,
    ...(command === 'take-out' ? [`To: ${to}`] : []),
    ...(command === 'resume' ? [`Undoes stop: ${stop}`] : []),
    `Asked: ${iso(atMs)}, ${nonce}`,
  ].join('\n')
}

/**
 * A command's words read back, or null: this agent's, one of the three, a take-out to its own return
 * address only, a go-again naming the stop it undoes, asked within the window of `now`, with a
 * nonce. Nothing else is accepted.
 */
export function readCommand(agent: string, returnTo: string | null, message: string, now: number): { command: Command; atMs: number; nonce: string; stop: string | null } | null {
  const lines = message.split('\n')
  const command = (Object.keys(COMMAND_LINE) as Command[]).find((c) => lines[0] === `Cellula agent: ${COMMAND_LINE[c]}`)
  if (!command || lines[1] !== `Agent: ${agent}`) return null
  const rest = lines.slice(2)
  if (command === 'take-out') {
    if (!returnTo || rest.shift() !== `To: ${returnTo}`) return null
  }
  let stop: string | null = null
  if (command === 'resume') {
    stop = rest.shift()?.match(/^Undoes stop: ([0-9a-f]{16})$/)?.[1] ?? null
    if (!stop) return null
  }
  if (rest.length !== 1) return null
  const m = rest[0]!.match(/^Asked: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ), ([0-9a-f]{16})$/)
  if (!m) return null
  const atMs = Date.parse(m[1]!)
  if (!Number.isFinite(atMs) || Math.abs(now - atMs) > COMMAND_WINDOW_MS) return null
  return { command, atMs, nonce: m[2]!, stop }
}

/** The mark of an agent in the person's link (#phone=<token>.<mark>): the page signs for that agent
 * only, so a relay cannot show it another of the person's agents on this link. */
export const agentMark = (address: string) => createHash('sha256').update(address).digest('hex').slice(0, 12)

/**
 * Do these words carry a good signature by a key of the wallet behind `address`? 'yes', 'no', or
 * 'unsure' when the check itself failed (the chain could not be read just then, for a passkey
 * account's keys): an answer is not thrown away for that, it is checked again.
 */
export async function checkSigned(client: ccc.Client, message: string, sig: WalletSignature, address: string): Promise<'yes' | 'no' | 'unsure'> {
  if (typeof sig?.signature !== 'string' || typeof sig.identity !== 'string' || typeof sig.signType !== 'string') return 'no'
  try {
    let valid: boolean
    if (sig.signType === ACCOUNT_SIGN_TYPE) valid = await verifyAccountMessage(message, sig.signature, sig.identity)
    else if (sig.signType === PQ_SIGN_TYPE) valid = pqVerifyMessage(message, sig.signature as ccc.Hex, sig.identity as ccc.Hex)
    else if (sig.signType === ccc.SignerSignType.JoyId && !joyIdSignatureIsHonest(sig.signature)) valid = false
    else valid = await ccc.Signer.verifyMessage(message, new ccc.Signature(sig.signature, sig.identity, sig.signType as ccc.SignerSignType))
    if (!valid) return 'no'
    const want = (await ccc.Address.fromString(address, client)).script
    const locks = await locksForIdentity(client, sig.signType, sig.identity)
    return locks.some((l) => l.eq(want)) ? 'yes' : 'no'
  } catch {
    return 'unsure'
  }
}

/** checkSigned, as yes or no. */
export async function signedBy(client: ccc.Client, message: string, sig: WalletSignature, address: string): Promise<boolean> {
  return (await checkSigned(client, message, sig, address)) === 'yes'
}
