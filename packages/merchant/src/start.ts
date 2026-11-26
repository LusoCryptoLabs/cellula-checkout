// A merchant on a server in one call: the shop's Fiber session (signer and channel state in a file
// beside its other keys), its channel opened from the shop's own testnet key when there is none, and
// the merchant on top. Testnet only for now: LSP3, as the Cellula wallet uses it.

import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { ccc } from '@ckb-ccc/core'
import { FiberSession, lspTerms, rentStatus, type FiberConfig } from '../../../vendor/fiber-session/index.ts'
import { nodeHost } from '../../../vendor/fiber-session/node.ts'
import { ckbOf } from './amount.ts'
import { Merchant } from './merchant.ts'
import { NodeSession, type NodeRpc } from './node-session.ts'
import { ownNodeRoom, type RoomRail } from './room.ts'
import type { WebhookTarget } from './webhook.ts'

import { CHANNEL_FILE, LAB_GATEWAY, LSP3_NODE, lsp3Ready, RESERVE_CKB } from './lsp3.ts'

export { LAB_GATEWAY }

/** LSP3 on testnet, as the Cellula wallet uses it. */
export function lsp3Testnet(gateway = LAB_GATEWAY): FiberConfig {
  return {
    gateway,
    lspPubkey: LSP3_NODE.pubkey,
    lspShutdown: { code_hash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8', hash_type: 'type', args: LSP3_NODE.shutdownArgs },
    ckbNodes: ['https://testnet.ckb.dev/', 'https://testnet.ckbapp.dev/'],
    currency: 'Fibt',
    reserveCkb: BigInt(RESERVE_CKB),
    spend: { min: 10n, max: 1000n, default: 10n },
    // A server signs without a person to ask: the step-up never applies.
    stepUpCkb: 1_000_000n,
    // Kept as they are: a shop's channel was opened under these names.
    ownerKey: (lockHash) => `cellula-fiber-merchant:${lockHash}`,
    lockName: 'cellula-fiber-merchant:signer',
    invoiceDescription: 'Payment',
    item: 'payment',
  }
}

export type StartOptions = {
  /** Holds channel3.json (the channel and its secrets, keep it like a key) and merchant.json. */
  dir: string
  /** The shop's testnet key (hex): it funds the channel's reserve and gets the money when it closes. */
  key: string
  /** CKB the shop puts in beside the 100 CKB reserve when it opens a channel. */
  openCkb?: number
  webhook?: WebhookTarget
  gateway?: string
  log?: (line: string) => void
  /** When rented room is brought into a channel (MerchantOptions.roomPlace). */
  roomPlace?: 'idle' | 'manual'
  /** A pay link (FiberConfig.link): invoices made ahead and left with the LSP's gateway, so a name
   * that publishes the link is paid while nobody asks this server for an invoice. Turned on with
   * the session's openLink(). */
  link?: FiberConfig['link']
  /** How long the session waits between rounds while nothing moves (FiberConfig.idleTickMs; 4 s
   * unless told): less answers a payment's first signature sooner. */
  idleTickMs?: number
  /** Given the session as soon as it is made, before the channel opens: its log from the start. */
  onSession?: (session: FiberSession) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Renting room for a hosted shop (room.ts): asked and paid by its session, the channel taken out
 * and the process started again to bring the room in (the new channel is a new tenant, so the
 * rent moves to it then). */
function hostedRoom(session: FiberSession, gateway: string, log: (line: string) => void): RoomRail {
  return {
    terms: async () => (await lspTerms(gateway)).rent,
    rent: (room, months) => session.rentRoom(room, months),
    status: (h) => rentStatus(gateway, h),
    move: (h, claim) => session.moveRent(h, claim),
    async place() {
      const c = session.state.channel
      if (c?.ready && !c.closed) await session.close()
      for (let i = 0; i < 240 && !session.state.channel?.closed; i++) await sleep(2500)
      if (!session.state.channel?.closed) throw new Error('the channel did not close in ten minutes')
      log('closed: starting again, to open the channel with the rented room')
      // On a server this ends the process (exit 75); the service starts it again.
      await session.startOver()
    },
  }
}

export async function startMerchant(o: StartOptions): Promise<{ merchant: Merchant; session: FiberSession; wallet: ccc.Signer }> {
  const log = o.log ?? ((line: string) => console.log(line))
  lsp3Ready()
  mkdirSync(o.dir, { recursive: true })
  const config = { ...lsp3Testnet(o.gateway), ...(o.link ? { link: o.link } : {}), ...(o.idleTickMs ? { idleTickMs: o.idleTickMs } : {}) }
  const session = new FiberSession(nodeHost({ file: path.join(o.dir, CHANNEL_FILE) }), config)
  o.onSession?.(session)
  const wallet = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), o.key.startsWith('0x') ? o.key : `0x${o.key}`)
  const merchant = await Merchant.open({ session, file: path.join(o.dir, 'merchant.json'), webhook: o.webhook, log, room: hostedRoom(session, config.gateway, log), roomPlace: o.roomPlace })
  const c = session.state.channel
  if (c?.closed) {
    log('the last channel is closed: opening a new one')
    await session.startOver()
  }
  if (!session.state.channelId && !session.state.opening) {
    log(`opening a channel from ${await wallet.getRecommendedAddress()} with ${o.openCkb ?? 10} CKB beside the reserve, the LSP's opening fee on top if it asks one`)
    await session.open(wallet, BigInt(o.openCkb ?? 10))
  }
  if (!session.state.channel?.ready) await session.whenReady()
  // The LSP's opening fee, once per wallet, on top of what the channel spends: until it is paid the
  // channel takes no payment (merchant.ts payOpeningFee, tried again if it fails).
  await merchant.payOpeningFee()
  const s = merchant.status()
  log(s.ready ? `ready: can receive ${s.can_receive_ckb} CKB, holds ${s.balance_ckb} CKB` : `not ready yet: the opening fee is not paid (${ckbOf(session.state.feeDue)} CKB), tried again in a minute`)
  return { merchant, session, wallet }
}

/** A merchant whose shop runs its own Fiber node (docs/OWN-NODE.md): invoices made and settled by
 * that node, no hosted session and no key here. The node's channels are the shop's to open. */
export async function startOwnNodeMerchant(o: {
  dir: string
  node: NodeRpc
  webhook?: WebhookTarget
  log?: (line: string) => void
  /** Renting room from an LSP (room.ts): its gateway and its node's key; LSP3 on testnet unless told. */
  gateway?: string
  lspPubkey?: string
  /** CKB the shop's node puts in a channel opened for rented room (109 unless told). */
  roomOpenCkb?: number
  roomPlace?: 'idle' | 'manual'
}): Promise<{ merchant: Merchant; session: NodeSession }> {
  const log = o.log ?? ((line: string) => console.log(line))
  mkdirSync(o.dir, { recursive: true })
  if (!o.lspPubkey) lsp3Ready()
  const session = new NodeSession(o.node)
  const lsp = lsp3Testnet(o.gateway)
  const room = ownNodeRoom({ gateway: lsp.gateway, lspPubkey: o.lspPubkey ?? lsp.lspPubkey, node: session, openCkb: o.roomOpenCkb })
  const merchant = await Merchant.open({ session, file: path.join(o.dir, 'merchant.json'), webhook: o.webhook, log, room, roomPlace: o.roomPlace })
  const s = merchant.status()
  log(s.ready ? `ready on the shop's own node: can receive ${s.can_receive_ckb} CKB, holds ${s.balance_ckb} CKB` : "the shop's own node has no ready channel yet")
  return { merchant, session }
}
