// An agent on a person's computer or server in one call: its Fiber session (signer and channel state
// in a file beside its key), its channel opened from its own testnet key when there is none, and the
// agent on top. Testnet only for now: LSP3, as the merchant kit uses it.

import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { ccc } from '@ckb-ccc/core'
import { FiberSession } from '../../../vendor/fiber-session/index.ts'
import { nodeHost } from '../../../vendor/fiber-session/node.ts'
import { Agent, type AgentCaps } from './agent.ts'
import { ckbOf } from './amount.ts'
import { CHANNEL_FILE, lsp3Ready } from './lsp3.ts'
import { lsp3Testnet } from './start.ts'

export type AgentStartOptions = {
  /** Holds channel3.json (the channel and its secrets, keep it like a key) and agent.json. */
  dir: string
  /** The agent's own testnet key (hex): it funds the channel, and the channel's money comes back to
   * it when it closes. */
  key: string
  /** CKB the agent puts in its channel beside the 100 CKB reserve (20 unless told; 10 to 1,000). */
  openCkb?: number
  caps?: AgentCaps
  /** The person's address the balance is sent back to once taken out. Fixed here: the API never
   * names another. */
  returnTo?: string
  /** Sellers and payees it may pay, a payment above which waits for the person, and where they
   * approve (agent.ts). */
  allow?: string[]
  approveAboveCkb?: string
  approvalsUrl?: string
  /** The person also approves on their phone (agent-phone.ts). */
  phone?: boolean
  gateway?: string
  log?: (line: string) => void
  onSession?: (session: FiberSession) => void
}

/** Sends every plain cell of `wallet` to `to`, the fee taken from it. */
export async function sweepTo(wallet: ccc.Signer, to: string): Promise<string> {
  const { script } = await ccc.Address.fromString(to, wallet.client)
  const tx = ccc.Transaction.from({ outputs: [{ lock: script }] })
  await tx.completeInputsAll(wallet)
  await tx.completeFeeChangeToOutput(wallet, 0, 1000)
  return wallet.sendTransaction(tx)
}

/** The session and the agent, with no channel opened yet: openAgent() opens it once the agent's
 * address holds enough. */
export async function startAgent(o: AgentStartOptions): Promise<{ agent: Agent; session: FiberSession; wallet: ccc.Signer; address: string }> {
  const log = o.log ?? ((line: string) => console.log(line))
  lsp3Ready()
  mkdirSync(o.dir, { recursive: true })
  const config = {
    ...lsp3Testnet(o.gateway),
    ownerKey: (lockHash: string) => `pay-with-fiber-agent:${lockHash}`,
    lockName: 'pay-with-fiber-agent:signer',
    spend: { min: 10n, max: 1000n, default: 20n },
    // The LSP's opening fee, as NPM.md tells the person: a gateway asking more at the opening is refused
    // before anything is spent.
    openingFeeMost: 500n * 100_000_000n,
  }
  const session = new FiberSession(nodeHost({ file: path.join(o.dir, CHANNEL_FILE) }), config)
  o.onSession?.(session)
  const wallet = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), o.key.startsWith('0x') ? o.key : `0x${o.key}`)
  const address = await wallet.getRecommendedAddress()
  if (o.returnTo) await ccc.Address.fromString(o.returnTo, wallet.client)
  const agent = await Agent.open({ session, file: path.join(o.dir, 'agent.json'), caps: o.caps, returnTo: o.returnTo, allow: o.allow, sharedPayees: [config.lspPubkey], approveAboveCkb: o.approveAboveCkb, approvalsUrl: o.approvalsUrl, phone: o.phone, sweep: (to) => sweepTo(wallet, to), balance: () => wallet.getBalance(), log })
  return { agent, session, wallet, address }
}

/** Opens the agent's channel when it has none, from its own address, and waits until it can pay.
 * Throws what the opening says (not enough CKB at the address, no room at the LSP). */
export async function openAgent(s: { session: FiberSession; wallet: ccc.Signer; address: string }, o: { openCkb?: number; log?: (line: string) => void } = {}): Promise<void> {
  const log = o.log ?? ((line: string) => console.log(line))
  const c = s.session.state.channel
  if (c?.closed) {
    log('the last channel is closed: starting again to open a new one')
    // On a server this ends the process (exit 75); the service starts it again.
    await s.session.startOver()
    return
  }
  if (!s.session.state.channelId && !s.session.state.opening) {
    log(`opening the agent's channel from ${s.address} with ${o.openCkb ?? 20} CKB beside the 100 CKB reserve, the LSP's opening fee on top if it asks one`)
    await s.session.open(s.wallet, BigInt(o.openCkb ?? 20))
  }
  if (!s.session.state.channel?.ready) await s.session.whenReady()
  if ((s.session.state.feeDue ?? 0n) > 0n) {
    log(`paying the LSP's opening fee, ${ckbOf(s.session.state.feeDue)} CKB once`)
    await s.session.payOpeningFee()
  }
  log(`ready: holds ${ckbOf(s.session.state.channel?.local ?? 0n)} CKB`)
}
