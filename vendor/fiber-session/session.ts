// One Fiber channel per host: the signer of a tenant of a hosted LSP (Fiber PR #1623), with its
// keys and its invoice secrets kept by the host; the LSP asks it for every signature and holds
// payments while it is away. First written for the cellula.id app, where each part was seen
// working on testnet. It reaches the LSP only through the gateway, and checks
// the chain on public CKB nodes, never through the LSP.
//
// Like a wallet it can come back elsewhere: in a browser, opening a channel makes a passkey, and
// every change to the signer's state is kept encrypted by the gateway under a key from it.
// Unlike a wallet, a channel's state changes with every payment and must never be signed from
// two places, so one tab signs (the host's lock) and one device (the gateway's lease), and a
// host behind the backup catches up before it signs.

import { ccc } from '@ckb-ccc/core'
import type { LspSigner } from './signer/cellula_lsp_signer.js'
import type { Host, Store } from './host.ts'
import { ckb, closeFeeRateBy, CLOSE_FEE_RATE_MOST, fiberTxHash, fundingFeeRate, fundingLock, giveUpFunding, signClaim, signFunding, toFiberScript, type FiberScript, type FiberTransaction } from './funding.ts'
import { closeNoLongerNeedsPage, comingIn, fundingPut, fundingShort, fundingStranded, inFlight, neverFunded, openingFailure, pageNoLongerNeeded, paidOut, removalConfirmed, turnWait, waitSettled, walletCapOpen, walletKey, type CellPoint } from './opening.ts'
import { feeCap } from './fees.ts'
import { invoiceTerms } from './terms.ts'
import { channelDelay, type ChannelDelay } from './delay.ts'
import { historyOf, type HistoryItem } from './history.ts'
import { accessHash } from './keeper.ts'
import { VaultKeyLost } from './vault.ts'
import { needsPasskey, QUIET_MS, type Quiet } from './stepup.ts'
import { openRecoveryFile, packBackup, sealRecoveryFile, unpackBackup, type RecoveryHeader, type TokenCode } from './recovery-file.ts'

type Hex = `0x${string}`

/** How a pay link's invoices are signed, so a payer can tell them from any others the gateway
 * could hand out (cellula.id: the key published in a name's `fiber.link` record). */
export type LinkSigning = {
  publicKey(secret: Hex): string
  /** `endsAtMs`: when the invoice ends, as the invoice itself says (timestamp plus expiry). */
  sign(linkId: string, paymentHash: Hex, amount: bigint, endsAtMs: number, secret: Hex): string
}

export type FiberConfig = {
  /** The LSP's gateway, as `https://host/lsp2`. */
  gateway: string
  /** The LSP's node, the other side of every channel. */
  lspPubkey: string
  /** The LSP's own lock: its shutdown script on channels opened before the remote one was kept. */
  lspShutdown: FiberScript
  /** Public CKB nodes, never the LSP's: the signer checks the chain on its own. */
  ckbNodes: string[]
  currency: 'Fibt' | 'Fibb'
  /** What a channel holds back on the wallet's side, in CKB; it comes back at the close. */
  reserveCkb: bigint
  /** What a new channel may spend, in whole CKB. */
  spend: { min: bigint; max: bigint; default: bigint }
  /** A payment over this many CKB, and every close, asks for the passkey first, when there is one. */
  stepUpCkb: bigint
  /** The most an opening fee in CKB may be, in shannons (FEE_MOST when unset): a gateway asking more
   * at an opening is refused before anything is spent. */
  openingFeeMost?: bigint
  /** The commitment delay of new channels, in epochs (1 to 10, 1 when unset): the time to stop an
   * LSP that publishes an old state while the page is closed, and how long a close takes. More
   * than one needs the LSP to accept channels with a tlc_expiry_delta of two thirds of it
   * (delay.ts). */
  delayEpochs?: number
  /** How the gateway files a kept channel under the wallet that funds it. */
  ownerKey(lockHash: string): string
  /** The host lock that keeps one signer running. */
  lockName: string
  /** The description of the invoices this host makes. */
  invoiceDescription: string
  /** What a payment coming in is called in the log ("meal"). */
  item: string
  /** A pay link: a few open invoices for each of these amounts, left with the gateway. */
  /** `each`: open invoices kept for every amount (2); `everyMs`: how often they are made again
   * (60 s). A merchant that is always there keeps more, and makes them again sooner. */
  link?: LinkSigning & { amounts: bigint[]; each?: number; everyMs?: number; open?: OpenLink }
  /** How long the loop waits between rounds while nothing moves (IDLE_TICK_MS unless told). A host
   * that is always there, with no mobile data to spare, answers a payment's first signature
   * sooner at 1 s. */
  idleTickMs?: number
  /** Load tests only: every wait of the loop (its rounds, the channel's and invoices' reads) at
   * most this long, for what a payment takes without them. */
  loopFloorMs?: number
}

/** Invoices with no amount of their own on a pay link: `each` kept, each paid any amount from
 * `least` to `most` (in the channel's asset) that its payer chooses, a fraction included. */
export type OpenLink = { each: number; least: bigint; most: bigint }

// Names in the host's store. A browser keeps them under its prefix, as `cells:fiber:state`.
const STATE = 'state'
const INVOICES = 'invoices'
const CHANNEL_INFO = 'channel'
/** What a channel of CKB sets aside on the legacy commitment-lock layout (57-byte args), in shannons:
 * every wallet channel opened before 2026-11-05 was on it. */
const LEGACY_RESERVE = 99n * 100_000_000n
const OWNER = 'owner'
const SENT = 'sent'
// The pay link is on, so the host keeps it full of invoices.
const LINK_ON = 'link-on'
// The key this host signs its link's invoices with; its public half is published elsewhere.
const LINK_KEY = 'link-key'
// The payments made without the passkey lately (stepup.ts), kept so a reload does not start the
// count again.
const QUIET = 'quiet'
const DEVICE = 'device'
// The gateway's last word on this copy (its answer to hello), kept so that a reload with the LSP
// silent still knows it: closing on chain with a copy behind the LSP's can lose the whole balance
// to its watchtower. 'restored': taken from the gateway, and not
// yet greeted since, so the copy is only as new as the gateway said.
const VERDICT = 'hello-verdict'
// A channel brought here from the gateway's copy onto a device that had none of it (restore). The
// copy may be older than its last state: it may have signed since, and its own commitment may
// be revoked. Its signer marks the store restored before it signs anything,
// so no channel in it signs again, and asks the LSP to close the channel by force (RETIRE, until
// the gateway took the ask); the channel then takes no payments and is not left on its own
// (BROUGHT). Both hold the tenant's id.
const RETIRE = 'retire-nonces'
const BROUGHT = 'brought'
const BROUGHT_SAYS = 'This channel was brought here from its backup, so it takes no payment. The LSP closes it, and your share comes back once this app signs it after the close; then open a new one.'
// How often the tenant token's end is looked at while the page runs (renewToken): it is renewed a
// week before it ends (tokens last 30 days on the LSP3 line).
const RENEW_CHECK_MS = 6 * 3600_000
// Preimages that came back with a restored backup, for payments held for this channel.
const PREIMAGES = 'preimages'
// Room rented from a channel (rentRoom) for the next one, which is a new tenant: the rent's payment
// hash and the claim that moves it. Not set aside with the channel; the next opening moves the rent
// to its node, and it goes once that channel is funded.
const ROOM_RENT = 'room-rent'
/** The channels of a token this host had, by id (their type script): `history` says each payment's token. */
const TOKEN_CHANNELS = 'token-channels'
const VERSION = 'backup-version'
const SEALED = { sealed: true }
const DAY = 86_400_000
// What the LSP's node says of a payment whose refund it holds before this signer signs it.
const REFUND_HELD = /its refund waits for this node's signature/
// The most the settlement after a force close may spend on its fee, in shannons (0.001 CKB).
const SETTLE_MAX_FEE = 100_000
// The genesis block, kept cut (FiberSession.ckbCall), under this name and its hash.
const GENESIS = 'genesis'
// When a channel set aside asks the LSP first, past the gateway's quiet time after a bye (settleAside).
const ASIDE_FIRST_MS = 15_000
// When each channel was set aside, under its suffix: only one set aside just now waits that out.
const ASIDE_AT = 'aside-at'
// What a channel set aside takes with it, its backup's count and the gateway's last word on it too:
// set aside without them, a channel still open came back as a copy older than its backup.
/** A channel this device closed on chain on its own (`recovery().publish`), its share not yet taken
 * back: `{ share, token, at }`. Said at once on the next start, while the LSP may not answer. */
const LEFT = 'left-on-own'
const ASIDE_NAMES = [STATE, INVOICES, CHANNEL_INFO, OWNER, LINK_ON, LINK_KEY, PREIMAGES, VERSION, VERDICT, LEFT]
// A channel set aside here and still open, brought back (bringBack), by its tenant: the key kept here
// may be another channel's, so it is checked against the backup before it seals one (afterBack).
const BACK = 'back-from-aside'
// How long a page waits for the channels set aside here to say whether one is still open.
const ASIDE_CHECK_MS = 10_000
// A channel set aside that the LSP says is settled, or lists no more, under its suffix: it can never
// be open again, so it is not asked about again. Kept, not removed (its keys stay, as for any set
// aside); a tester's phone asked LSP2 about every channel it ever set aside, at each start (2026-10-27).
const ASIDE_DONE = 'aside-done'
// The opening fee agreed when this device opened its channel: the fee invoice the gateway makes is
// checked against it, with the payee and this host's own payments, so a gateway that lies cannot
// have the channel pay more, to another node, or twice.
const FEE_AGREED = 'fee-agreed'
// The most an opening fee in CKB can be where no agreement was kept here (a channel opened before
// FEE_AGREED, or brought from elsewhere): twice LSP2's opening fee of 500 CKB.
const FEE_MOST = 1000n * 100_000_000n
// What the node says of a payment it never had.
const NEVER_SENT = /payment session not found/i
// A channel set aside is asked about every ASIDE_ROUND_MS; one whose side stays closing (ShuttingDown)
// with nothing to sign, less and less often, down to every ASIDE_SLOWEST_MS: maria.cell's keeper asked
// LSP2 about one every 10 s for eleven hours, each call waking that tenant (2026-10-27). So
// is one closed by force waiting for its delay: a tester's phone woke its old tenant every 10 s, and the
// gateway evicted it each time (2026-10-30).
const ASIDE_ROUND_MS = 10_000
const ASIDE_CALM = 6
const ASIDE_SLOWEST_MS = 5 * 60_000
// A channel still open at the LSP is never set aside, nor one not read: set aside, it would hold
// money while a second one opened.
const STILL_OPEN = 'Your channel is still open, so nothing was started again: take it out first.'
const NOT_READ = 'Your channel could not be read just now, so nothing was started again. Try again in a moment.'
const NOT_READ_HERE = 'The channel kept here could not be read just now, so another one was not brought here. Try again in a moment.'
const OPEN_HERE = 'The channel kept here is still open, so another one was not brought here: take it out first.'
const ASIDE_BACK = 'A channel set aside here is still open: it is the channel kept here again, and no new one was opened.'
// The pay link: two invoices for each amount, valid a week, made a few per round so making them
// never holds up the signing for long.
const LINK_EACH = 2
const LINK_BATCH = 8
const LINK_VALID = 7 * DAY
// An invoice made on the spot for a payer waiting at the gateway (its /lsp/link/live, 2026-11-16): an
// hour is enough to be paid now, and past the gateway's least (LIVE_LEFT_MIN, ten minutes).
const LIVE_VALID = 60 * 60 * 1000
// Every link invoice on offer is asked about once at start and then this often: a payment is found
// by its TLC's hash (settleInvoices), so this round is only in case one was missed. One call per
// invoice, one after the other, and the signer waits meanwhile: a keeper's 132 took 13 s from a
// computer at home, and at every 30 s they held up one payment in three by that much (2026-10-27).
const LINK_SWEEP_MS = 5 * 60_000
// A plain invoice is asked about every round for its first hour, then as a link's (settleInvoices).
const PLAIN_QUICK_MS = 60 * 60_000
// Calls that only read: a lost request is asked again. Calls that change something never are.
const READS = new Set(['get_channel_signing_status', 'get_watchtower_signing_status', 'list_channels', 'get_invoice', 'get_payment', 'list_payments', 'parse_invoice'])
// What the LSP answers a tenant token that ended (fnn rpc middleware): the page renews it and asks
// again (renewToken). Its other refusals ("Unauthorized: ..." for a limit) are not a token's end.
const TOKEN_REFUSED = /^Unauthorized(?!:)/
// A backup sealed at a save and sent with no call after it, this long after (backupSoon).
const BACKUP_ALONE_MS = 1000

// Sealed for one tenant, sent with its own token: a channel set aside or restored meanwhile is
// another's, and its backup is never sent over it (takeDue).
type BackupDue = { version: number; tenant: string; token: string; body: Record<string, unknown> }
const envelope = (method: string, params: string) => `{"jsonrpc":"2.0","id":1,"method":${JSON.stringify(method)},"params":[${params}]}`

// `tlc_max`: the latest TLC expiry the signer takes for it (terms.ts); invoices made before it
// was kept took 7 days only. `refused`: a payment arrived that did not match it, and the signer
// will not release its secret.
type Invoice = { channel_id: string; payment_hash: string; preimage: string; amount: string; address: string; status: string; released?: boolean; refused?: boolean; link?: boolean; expires_at?: number; tlc_max?: number; paid_at?: number; open?: boolean; made_at?: number }
// What the signer says when it will not release an invoice's secret for a payment it took in
// cancelled (fiber-lsp-sdk, release_preimage).
const REFUSED_RELEASE = /incorrect preimage release authorization/
/** `back`: failed after it had left, its amount back on chain with its channel's settlement
 * (endAsideSent). */
type Sent = { channel_id: string; payment_hash: string; amount: string; status: string; resolved?: boolean; preimage?: string; at?: number; expires_at?: number; what?: 'fee'; back?: true; fee?: string }
type RawChannel = {
  channel_id: string
  state: { state_name: string; state_flags?: string }
  /** The funding cell: its transaction's hash and its index, 4 bytes little endian. */
  channel_outpoint?: string
  local_balance: string
  remote_balance: string
  pending_tlcs?: { amount?: string; payment_hash?: string; status?: Record<string, string> }[]
  /** The token the channel holds, absent for CKB. */
  funding_udt_type_script?: FiberScript | null
}
/** What is kept of the channel kept here (CHANNEL_INFO): the shutdown script the LSP gave it, for a
 * channel of a token the CKB it set aside from the wallet (`reserve`, hex, from the opening's terms),
 * for a channel of CKB the same (`ckb_reserve`: 100 CKB on the full payment hash layout, 99 on the
 * legacy one), and from the LSP's lists its funding cell and whether it was ever funded (refreshChannel). From the
 * funding the wallet signed, its hash (`funding`) and the cells it spends (`inputs`); `stranded` once
 * that funding is known never to reach the chain (fundingNeverLands). */
type ChannelInfo = {
  channel_id?: string
  remote_shutdown_script?: unknown
  reserve?: string
  ckb_reserve?: string
  outpoint?: string
  funded?: boolean
  funding?: string
  inputs?: CellPoint[]
  stranded?: boolean
}
/** An invoice made on demand (`FiberSession.invoice`), to hand to whoever pays it. */
/** `link` and `sig`: when this host's pay link is on, the invoice comes signed by the link's key,
 * as the link's own invoices are, so a payer who knows the link (a name's `fiber.link`) can tell
 * it is this host's however it reached them. */
/** Where a channel's money stands for leaving without the LSP (`FiberSession.recovery`).
 * `share`: this side's balance in the latest commitment, in shannons. `open`: nothing is on chain
 * yet. `published`: that commitment is on chain; `commitmentLive`: a cell of it is still unspent.
 * `pendingPayments`: payments still in that cell. `next`, once it is out: what can be claimed
 * next, one transaction each, in the watchtower's order: a payment held for this side (`paymentIn`,
 * with the preimage this device kept), one of its own taken back once expired (`paymentBack`),
 * then the share; `ready` once its delay has passed, `needsWallet` when a plain cell of the wallet
 * goes in beside it. `wait`: nothing until `until` (ms), when known; `shareNow`, when the share
 * waits on payments of this side still pending: the share can be taken now instead (`amount`),
 * leaving `atRisk` to whoever takes the second share (2026-10-13). `penalty`: the LSP
 * sent on chain a commitment it had revoked, and its whole cell is ours now (a wallet cell pays the
 * fee). `closedByPeer`: the LSP closed with its own current commitment; our share and payments are
 * in that one, `published` is true and the same steps take them out of it.
 * `mature`: `next` is ready. */
export type ShareNow = { amount: bigint; atRisk: bigint; ready: boolean; needsWallet: boolean }
export type RecoveryNext =
  | { kind: 'claim'; claim: 'share' | 'paymentIn' | 'paymentBack' | 'penalty'; amount: bigint; ready: boolean; needsWallet: boolean }
  | { kind: 'wait'; until?: number; shareNow?: ShareNow }
  | { kind: 'done' }
  | { kind: 'publish' }
export type RecoveryStatus = { share: bigint; pendingPayments: number; open: boolean; published: boolean; closedByPeer: boolean; commitmentLive: boolean; mature: boolean; next: RecoveryNext; commitmentTx: string }
/** `claim`: the next claim, sent; `wallet` signs its cell when the claim needs one: the wallet
 * the channel was opened from gets it back whole, any other gives only what the claim lacks.
 * `claimShareNow`: the share now, beside pending payments (`RecoveryNext.shareNow`). */
export type Recovery = { channelId: string; status(): Promise<RecoveryStatus>; publish(): Promise<string>; claim(wallet?: ccc.Signer): Promise<string>; claimShareNow(wallet?: ccc.Signer): Promise<string> }

export type Sale = { paymentHash: string; amount: bigint; invoice: string; expiresAt: number; link?: string; sig?: string }

/** An invoice as the signer reads it. `payee`: the payee's public key (33 bytes, hex), when the
 * invoice names one. */
export type ReadInvoice = { payment_hash: string; amount: string | null; currency: string; hash_algorithm: string; timestamp_ms: number; expiry_ms: number | null; final_expiry_delta_ms?: number; payee?: string | null; expired: boolean; udt_type_script?: FiberScript | null }

/** Whether two scripts (or two nones) are the same, as JSON-RPC writes them. */
export function sameScript(a?: FiberScript | null, b?: FiberScript | null): boolean {
  if (!a || !b) return !a && !b
  return a.code_hash.toLowerCase() === b.code_hash.toLowerCase() && a.hash_type === b.hash_type && a.args.toLowerCase() === b.args.toLowerCase()
}

export type FiberChannel = {
  id: string
  ready: boolean
  closed: boolean
  /** Closed by force, its share still on chain until this host signs it over. */
  unsettled: boolean
  /** Closed by force at some point (settled or not). */
  forced: boolean
  stateName: string
  /** The token the channel holds (its type script), null for CKB. Its amounts (local, remote,
   * going) are then in the token's smallest unit, and it pays and is paid in it only. */
  token: FiberScript | null
  /** The token's name and decimals, as kept from its opening (TokenKept); null for CKB. A token
   * kept with no name says ''. */
  unit: { name: string; decimals: number } | null
  /** The CKB the channel set aside from the wallet for its cell, in shannons, which come back when it
   * closes: fnn's lists do not say them, the opening's terms do. For a token, null where this device
   * did not open it. For CKB, as its opening kept them (100 CKB on the full payment hash layout), or
   * the legacy layout's 99 CKB for a channel opened before those were kept (2026-11-05), when every
   * wallet channel was on it, or opened elsewhere. */
  reserve: bigint | null
  /** Yours, in shannons, including what is on its way; a payment paid (its payee's secret here) is
   * out of it at once, though the LSP lists it until its removal is signed (paidOut). */
  local: bigint
  /** What the channel can still take in. */
  remote: bigint
  /** Sent and not settled in the channel yet: on its way (a payment the LSP keeps for a payee who
   * is away), or paid and its removal still being signed. */
  going: bigint
  /** Payments are coming in: this host must keep answering until they are in. */
  receiving: boolean
  /** The opening fee's payment from this channel is paid (its secret here), so the fee is out of
   * `local`, though feeDue says it is due until the gateway has seen it paid, seconds later. An app
   * that takes feeDue off `local` takes it off only while this is false. */
  feePaid: boolean
  /** The funding cell, as the LSP lists it from the opening on: its transaction's hash and its
   * index, 4 bytes little endian; null while it lists none. The chain tells from it whether the
   * channel's CKB are in it yet, or back in the wallet: until its funding is in a block they are
   * still the wallet's, and once its close is they are the wallet's again. */
  outpoint: string | null
}

export type FiberState = {
  /** off: never started here; elsewhere: another tab of this browser signs. */
  phase: 'off' | 'starting' | 'running' | 'elsewhere' | 'failed'
  tenantId: string | null
  /** The channel this tenant opened, once the LSP has built it; null while none is (an opening
   * the LSP refused leaves a tenant with no channel, and it may open again). */
  channelId: string | null
  channel: FiberChannel | null
  opening: boolean
  closing: boolean
  /** Kept with a passkey from this browser. */
  kept: boolean
  /** Kept with a passkey, but this browser is behind it: bring it up to date with the passkey. */
  behind: boolean
  /** Kept with a passkey before access codes: another browser cannot bring it back until it is
   * kept again (one passkey tap), since the gateway hands a backup out only with the code. */
  rekeep: boolean
  /** The opening this tenant started was never funded: the wallet did not sign it, and the LSP
   * dropped it or is waiting for a signature this page can no longer give; or the wallet signed it
   * and its funding can never reach the chain, the LSP having dropped it (fundingStranded). Nothing
   * left the wallet; `startOver` opens the way to a new channel. */
  unfunded: boolean
  /** This host's pay link, once made. */
  link: string | null
  /** The public key this host signs its pay link's invoices with, if it keeps one. */
  linkKey: string | null
  /** The LSP's opening fee, in shannons, while unpaid: until it is paid the gateway
   * takes no other payment in or out of this channel. 0 when nothing is due. */
  feeDue: bigint
  /** When the LSP closes this channel for being unused, in ms, once it has said so (the gateway's
   * IDLE_DAYS); a payment before then keeps it. Null when no close is planned. */
  idleCloseAt: number | null
  /** Brought here from its backup onto a device that had none of it: it
   * is only closed together with the LSP. */
  brought: boolean
  /** Since when its signer has refused the signature the channel waits for, once that has lasted
   * STUCK_AFTER_MS: no payment in it finishes (a channel brought to another device and back, a
   * tester's phone on 2026-10-30). `askClose` has the LSP close it by force. Null while it signs. */
  stuck: { since: number } | null
  /** The gateway or its LSP did not answer the last hello (down, or restarting): the session asks
   * again every 5 s, and the host can say at once that the channel cannot be read, rather than wait
   * (the wallet's end to end test of 2026-11-05: Home held every row for a minute). A slow answer is
   * not this: only a failed request or a 5xx. */
  unanswered: boolean
  /** Closed on chain from this device on its own (`recovery().publish`), its share not yet taken
   * back: `share` as the recovery read it (shannons, or the token's units when `token`). Kept, so a
   * start that cannot reach the LSP says so at once; it went on as an open balance (the same test).
   * Gone once the recovery says nothing is left. */
  left: { share: bigint; token: boolean; at: number } | null
  /** The channel kept here is not open, and those set aside here are asked whether one still is: if
   * one is, it comes back as the channel kept here and the host starts again (bringBack). Until they
   * answer (ASIDE_CHECK_MS at most), "none here" is not known yet. */
  asideChecking: boolean
  /** Channels set aside here for a new one whose share is still on chain: closing, or closed by
   * force and not settled. Their rounds (settleAside) sign it back to the wallet once the chain
   * allows, and each leaves the list once settled. `since`: when it was set aside here, in ms.
   * `token`: the token the channel holds (its type script), null for CKB. `share`: this side's
   * part of its last commitment, before the claim's fee and without a payment still in it, once its
   * signer has read it: in shannons for CKB, the reserve set aside in it included (118.0 for 19.0 of
   * balance), and in the token's smallest unit for a token (a tester's phone, 2026-10-30: about 138 CKB
   * coming back from a channel set aside, and Home said only the new balance). */
  asideBack: { channel: string; since: number; token: FiberScript | null; share?: bigint }[]
  status: string
  log: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// The signer's rounds: every IDLE_TICK_MS while nothing moves, faster for BUSY_MS after something
// did (FiberSession.nextTick).
const IDLE_TICK_MS = 4000
const BUSY_MS = 30_000
// How long an answer that no watchtower settlement waits for the signer is kept (watchtowerAsk).
const WATCHTOWER_NONE_MS = 30_000
// How long a channel's next request, read with a signature's answer, stands for asking (channelAsk).
const NEXT_STATUS_MS = 1000
// A signer that refuses the channel's request: after REFUSING_CALM_MS its rounds, and the LSP's
// changes, come every STUCK_TICK_MS instead of at once (a stuck tenant's changes woke it 5 times a
// second, 110 refusals in 20 s, testnet, 2026-10-30); after STUCK_AFTER_MS it is stuck.
const REFUSING_CALM_MS = 3000
const STUCK_TICK_MS = 15_000
const STUCK_AFTER_MS = 20_000
const FORCING_SAYS = 'The LSP is closing this channel by force. Your CKB comes back to your wallet on chain: your share once the chain allows, and a payment that was in it once it ends.'
const IN_USE_SAYS = 'Your Fiber balance is in use on another device right now. Close the wallet there, or wait a minute, then bring it here, where it can only be taken out.'

/** The channel a signer call names, lower case, or null. */
function channelOf(params: string): string | null {
  try {
    const id = (JSON.parse(params) as { channel_id?: unknown }).channel_id
    return typeof id === 'string' ? id.toLowerCase() : null
  } catch {
    return null
  }
}

// An invoice's payment can sit in a channel for up to two weeks past its own expiry (terms.ts).
const PREIMAGE_KEPT_MS = 15 * 24 * 60 * 60 * 1000
/** How long a CKB node has to start its answer (its headers). The answer itself may take longer:
 * the genesis block is 2.3 MB on testnet. */
const CKB_ANSWER_MS = 10_000

/** A JSON-RPC caller over public CKB nodes. A phone loses requests now and then, and a
 * settlement's check makes dozens: each call is tried again, on the next node. A node that has not
 * started its answer within CKB_ANSWER_MS is left as one that failed: one that took the request and
 * stalled held the call as long as it stalled, and the next node was never asked (a top-up of
 * 2026-10-27, 74 s between the tenant's register and its hello). */
export function ckbCaller(nodes: string[]): (method: string, params: string) => Promise<string> {
  return async (method, params) => {
    const body = `{"jsonrpc":"2.0","id":1,"method":${JSON.stringify(method)},"params":${params}}`
    let last: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      const node = nodes[attempt % nodes.length] as string
      const stop = new AbortController()
      const timer = setTimeout(() => stop.abort(new Error(`${node} did not answer within ${CKB_ANSWER_MS / 1000} s`)), CKB_ANSWER_MS)
      try {
        const r = await fetch(node, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: stop.signal })
        // Answering: its body is read whole, however long that takes.
        clearTimeout(timer)
        if (r.ok) return await r.text()
        last = new Error(`${node} answered ${r.status}`)
      } catch (e) {
        last = e
      } finally {
        clearTimeout(timer)
      }
      await sleep(300 * (attempt + 1))
    }
    throw last
  }
}

/** The hash a get_block_hash answer gives, or null. */
function genesisHashOf(answer: string): string | null {
  try {
    const h = JSON.parse(answer).result
    return typeof h === 'string' && /^0x[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null
  } catch {
    return null
  }
}

/** A genesis block's answer cut to what the signer reads of it, its second transaction's hash
 * (lsp-signer chain.rs settlement_deps; a test reads that source): the other transactions keep their
 * hash and lose their contents, the block its uncles and proposals. Null for any block but the one
 * whose hash the endpoint gave, or an answer that is not a block. */
function genesisCut(answer: string, hash: string): string | null {
  try {
    const body = JSON.parse(answer)
    const block = body.result
    if (!block || String(block.header?.hash).toLowerCase() !== hash || !Array.isArray(block.transactions) || !block.transactions[1]?.hash) return null
    const empty = (t: Record<string, unknown>) => ({ ...t, cell_deps: [], header_deps: [], inputs: [], outputs: [], outputs_data: [], witnesses: [] })
    return JSON.stringify({ ...body, result: { ...block, uncles: [], proposals: [], transactions: block.transactions.map((t: Record<string, unknown>, i: number) => (i === 1 ? t : empty(t))) } })
  } catch {
    return null
  }
}

/** The steps of leaving without the LSP, for a signer started from a copy of the channel (this
 * device's, or a recovery file's) with the chain configured: what can be claimed, the close on
 * chain, and each claim, the wallet adding a cell where one is needed. */
async function recoveryOf(signer: LspSigner, ckb: (method: string, params: string) => Promise<string>, preimages: () => Promise<Record<string, string>>): Promise<Recovery> {
  const channelId: string | undefined = JSON.parse(await signer.status()).bound_channel_ids[0]
  if (!channelId) throw new Error('This copy holds no channel.')
  const shutdown: FiberScript = JSON.parse(await signer.openingRequest()).shutdown_script
  const destination = JSON.stringify(shutdown)
  const known = async () => JSON.stringify(await preimages())
  // A claim that needs a cell beside it takes one from `wallet`: the wallet the channel was opened
  // from gets it back whole, any other gives only what the claim lacks.
  const send = async (wallet: ccc.Signer | undefined, make: (helper: string) => Promise<string>): Promise<string> => {
    let helper = 'null'
    if (wallet) {
      const lock = (await wallet.getRecommendedAddressObj()).script
      const deps = await fundingLock(wallet).then((f) => (f.lock.eq(lock) ? f.cellDeps : []), () => [])
      helper = JSON.stringify({ lock: toFiberScript(lock), cell_deps: deps })
    }
    const out = JSON.parse(await make(helper))
    if (out.tx_hash) return out.tx_hash as string
    if (!wallet) throw new Error('This step needs a little CKB from a wallet beside it. Connect one.')
    const signed = await signClaim(out.unsigned_tx, wallet)
    const sent = JSON.parse(await ckb('send_transaction', JSON.stringify([signed, 'passthrough'])))
    if (sent.error) throw new Error(`The chain refused the claim: ${sent.error.message}`)
    return sent.result as string
  }
  return {
    channelId,
    status: async () => {
      const s = JSON.parse(await signer.recoveryStatus(channelId, destination, await known()))
      const n = s.next
      const next: RecoveryNext =
        n.kind === 'claim'
          ? { kind: 'claim', claim: n.claim === 'payment_in' ? 'paymentIn' : n.claim === 'payment_back' ? 'paymentBack' : n.claim === 'penalty' ? 'penalty' : 'share', amount: BigInt(n.amount), ready: n.ready, needsWallet: n.needs_wallet }
          : n.kind === 'wait'
            ? {
                kind: 'wait',
                until: n.until_ms ?? undefined,
                shareNow: n.share_now ? { amount: BigInt(n.share_now.amount), atRisk: BigInt(n.share_now.at_risk), ready: n.share_now.ready, needsWallet: n.share_now.needs_wallet } : undefined,
              }
            : { kind: n.kind }
      return {
        share: BigInt(s.share),
        pendingPayments: s.pending_payments,
        open: s.open,
        published: s.published,
        closedByPeer: s.closed_by_peer === true,
        commitmentLive: s.commitment_live,
        mature: s.mature,
        next,
        commitmentTx: s.commitment_tx,
      }
    },
    publish: async () => JSON.parse(await signer.publishCommitment(channelId)).tx_hash,
    claim: (wallet?: ccc.Signer) => send(wallet, async (helper) => signer.claimNext(channelId, destination, await known(), helper)),
    claimShareNow: (wallet?: ccc.Signer) => send(wallet, async (helper) => signer.claimShareNow(channelId, destination, await known(), helper)),
  }
}

/** Leave without the LSP from a recovery file (`FiberSession.recoveryFile`), on a page that holds
 * nothing of the channel: the same steps as `FiberSession.recovery`, the signer started from the
 * file, checking `ckbNodes` only. What it signs stays in memory. The file is a copy of the day it
 * was made: if the channel moved on after it, its commitment is an old one, and closing with it
 * can lose the whole balance to the LSP's watchtower (`header.created_at` says when). */
export async function recoveryFromFile(text: string, passphrase: string, opts: { ckbNodes: string[]; initSigner: Host['initSigner'] }): Promise<{ header: RecoveryHeader; recovery: Recovery }> {
  const { header, content } = await openRecoveryFile(text, passphrase)
  const wasm = await import('./signer/cellula_lsp_signer.js')
  await opts.initSigner(wasm.default)
  const ckb = ckbCaller(opts.ckbNodes)
  const signer = await wasm.LspSigner.create(
    {
      lsp: async () => {
        throw new Error('leaving without the LSP does not ask it anything')
      },
      ckb,
      save: async () => {},
    },
    content.state,
  )
  await signer.configureChain()
  // A file made before it said its tokens' code knows RUSD alone, as its signer does.
  if (content.tokens?.length) await signer.setTokens(JSON.stringify(content.tokens))
  return { header, recovery: await recoveryOf(signer, ckb, async () => content.preimages) }
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Whether a channel the LSP lists is open: funded, and neither closing nor closed. */
const stillOpen = (c: RawChannel) => c.state.state_name !== 'Closed' && c.state.state_name !== 'ShuttingDown' && !neverFunded(c, false)
/** Whether a channel set aside is over for good, from its tenant's list: closed with nothing left to
 * settle on chain, or no longer listed (an opening never signed, dropped). Unread is not over. */
const asideOver = (c: RawChannel | undefined, listed: RawChannel[] | undefined) =>
  c ? c.state.state_name === 'Closed' && !/WAITING_ONCHAIN_SETTLEMENT/.test(c.state.state_flags ?? '') : !!listed
/** Every 32 bytes the witnesses carry, by their hash: Fiber's (CKB's blake2b) and sha256. A secret
 * revealed on chain is one of them. */
async function secretsIn(witnesses: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const w of witnesses) {
    const bytes = ccc.bytesFrom(w)
    const all = Array.from({ length: Math.max(0, bytes.length - 31) }, (_, i) => bytes.slice(i, i + 32))
    const sha = await Promise.all(all.map((c) => crypto.subtle.digest('SHA-256', c)))
    all.forEach((c, i) => {
      found.set(ccc.hashCkb(c), ccc.hexFrom(c))
      found.set(ccc.hexFrom(new Uint8Array(sha[i]!)), ccc.hexFrom(c))
    })
  }
  return found
}
/** Whether a channel's share is still on chain, on its way back: closing, or closed by force and
 * not settled. */
const onItsWay = (c: RawChannel | undefined): c is RawChannel =>
  !!c && (c.state.state_name === 'ShuttingDown' || (c.state.state_name === 'Closed' && /WAITING_ONCHAIN_SETTLEMENT/.test(c.state.state_flags ?? '')))
const hex = (n: bigint) => `0x${n.toString(16)}`
const scriptHash = (s: FiberScript) => ccc.Script.from({ codeHash: s.code_hash, hashType: s.hash_type as ccc.HashTypeLike, args: s.args }).hash()
const NO_ROOM = 'The LSP has no room for a new channel right now, so nothing was asked of your wallet. Try again later.'
// A wallet may have at most a few channels open at the LSP at once (the gateway's WALLET_CAP, 2: a
// phone and a computer; since 2026-10-27). Said before the room: it is this wallet's own reason.
const WALLET_CAP = (n: number) => `Your wallet has ${n} channel${n === 1 ? '' : 's'} open at the LSP, the most a wallet may have, so nothing was asked of it. Close one to open another.`
const WALLET_CAP_UNKNOWN = 'How many channels your wallet has open at the LSP could not be read just now, so nothing was asked of it. Try again in a moment.'
// An unused channel's close (approveIdleClose): approved this long before its date, at the rate the
// gateway asks it with, which is the rate channels open with here (commitment_fee_rate).
const IDLE_APPROVE_EARLY_MS = 60_000
const LSP_CLOSE_FEE_RATE = 1000
// A channel the LSP lists while it waits for its funding: past these its funding is on chain.
const FUNDING_WAIT = new Set(['AwaitingTxSignatures', 'AwaitingChannelReady'])
// The LSP builds the funding from the wallet's own coins. When it cannot (too few, or all held by
// an earlier opening nobody signed, which the LSP lets go five minutes after building it), the
// tenant only hears that the opening was interrupted (seen 2026-10-07: CapacityNotEnough at the
// LSP, "tenant opening interrupted; retry the same request: timeout" here).
const NO_CHANGE = (free: string, put: bigint, keep: number) =>
  `Your wallet holds ${free} CKB: a top-up puts ${put} in and leaves ${keep} for the change, so nothing was asked of it. Put in less, or add CKB first.`
const NOT_BUILT = (ckb: bigint) =>
  `The LSP could not build the channel from your wallet, so nothing left it: the wallet needs ${ckb} CKB free, and coins held by an opening that was not signed come back about five minutes after it started. Try again then.`
// The gateway lets a few openings to the LSP at once and tells the rest how many are ahead
// (the gateway's `turn_of`; the load test of 2026-10-12, when 25 at once all timed out).
const BUSY = /busy: (\d+) ahead/
/** The LSP3 line takes a signed funding only after both commitment signatures are in (fnn
 * channel.rs, handle_submit_external_funding_tx), and this signer gives its own on the loop's next
 * round: a funding sent at once was refused (dev chain, 2026-11-20). */
const COMMITMENT_FIRST = /until peer CommitmentSigned is verified/

/** Sends the signed funding, asked again while the LSP says the commitment signatures are not all
 * in yet; `nudge` runs the signer's next round sooner. Any other refusal, or the same one past
 * `waitMs`, is thrown. */
export async function submitFunding(submit: () => Promise<unknown>, nudge: () => void, waitMs = 120_000, every = 1000, wait = sleep): Promise<void> {
  const end = Date.now() + waitMs
  for (;;) {
    try {
      await submit()
      return
    } catch (e) {
      if (!COMMITMENT_FIRST.test(message(e)) || Date.now() >= end) throw e
      nudge()
      await wait(every)
    }
  }
}
// An opening the LSP stopped because it took too long, the LSP being busy with others: not the
// wallet's coins, which the old sentence blamed.
const BUSY_SAID = 'The LSP is busy opening other channels, so nothing left your wallet. Try again in a minute.'
// A channel the LSP's node has just brought back (its restart, or the tenant woken) is listed as
// ready before the node routes over it, and a payment sent then fails ("max outbound liquidity 0").
// A failed payment cannot be sent again from here: the page approves its refund, and the signer
// then refuses a TLC for it. So the route is first built in a dry run, which records nothing, and
// tried again for a while if the channel is not routable yet.
const NOT_ROUTABLE_YET = /outbound liquidity 0\b/
const ROUTE_TRIES = 10

/** Room to receive rented from the LSP: what it costs a month, as a fraction of the
 * room, and the least and most room, in shannons; a month in ms. */
export type RentTerms = { perMonth: number; least: bigint; most: bigint; monthMs: number }

/** A rent as the LSP's gateway keeps it. `start` and `until` in ms; `until` null while unpaid.
 * `claim`, from the ask only: what moves the rent to another node later (moveRent). */
export type RoomRent = { paymentHash: string; room: bigint; months: number; price: bigint; paid: boolean; start: number | null; until: number | null; ended: boolean; closed: boolean; claim?: string }

/** A wallet that may open no more channels here, as the gateway says it (WALLET_CAP): `wallet_cap`
 * when it has the `most` open, `open` of them, each with when it was opened (ms) and what it was
 * funded with (shannons), null when not said; `wallet_cap_unknown` when the LSP could not say how
 * many are open and they could reach the most (`open` null, no channels). */
export type WalletCap = { code: 'wallet_cap' | 'wallet_cap_unknown'; open: number | null; most: number; channels: { opened: number | null; funded: bigint | null }[] }

export type LspTerms = { canOpen: boolean; openingFee: bigint; room: bigint | null; rent: RentTerms | null; walletCap: WalletCap | null; spendMax: bigint | null; tokens: TokenTerms[] }

/** A token the LSP opens Fiber balances of (the gateway's FIBER_TOKENS), as its gateway says it, in
 * the token's smallest unit: the room the LSP puts in, the opening fee for that wallet (0 when it
 * paid one before; null while the gateway cannot price it), the most a top-up of it spends, how much
 * of it the LSP holds and how many more openings that funds, and whether one can open now. */
export type TokenTerms = { name: string; script: FiberScript; decimals: number; room: bigint; openingFee: bigint | null; spendMax: bigint | null; held: bigint | null; channelsLeft: number | null; canOpen: boolean; cellDep: unknown; linkMost: number }

/** What this host keeps of a channel of a token, from its opening: the token's name and decimals as
 * the gateway said them, where its code is (for the signer, which needs it to leave without the
 * gateway too) and the whole units its pay link offers. An entry kept before 2026-10-28 is its bare
 * script, read as one with no name and 8 decimals. */
export type TokenKept = { script: FiberScript; name: string; decimals: number; cellDep?: unknown; linkMost?: number }

/** The whole units a pay link in a token offers when the gateway does not say (its TOKEN_LINK_MOST). */
const LINK_MOST = 25

const big = (v: unknown): bigint | null => (v == null || v === '' ? null : BigInt(v as string | number))

// How long the session waits in all when the gateway says to ask again (lspTerms, payOpeningFee).
const TERMS_WAIT_MS = 65_000

/** What an opening costs here and gives, as the LSP's gateway says: whether one can
 * open now, its fee and the room to receive it gives, in shannons (room null when not said), and
 * what more room costs to rent (null where it is not rented). The fee is owed once per wallet:
 * with `wallet` (walletKey of its lock) the gateway says what an opening from it owes, 0 when it
 * paid before, and `walletCap` when that wallet may open no more here (null when it may, or the
 * gateway does not say). `spendMax`, whole CKB, is the most a top-up spends here (SPEND_USD at the
 * CKB price, since 2026-10-27), null when not said. Told to ask again (429 or 503 with `retry_after`), it does, for about a minute in all. Free and open when the gateway does not answer:
 * the opening itself then says. */
export async function lspTerms(gateway: string, wallet?: string, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<LspTerms> {
  try {
    let r: Response
    for (let waited = 0; ; ) {
      r = await fetch(`${gateway}/capacity${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''}`)
      if (r.ok) break
      const after = Number((await r.json().catch(() => ({}))).retry_after) * 1000
      if (!(after > 0) || waited + after > TERMS_WAIT_MS) return { canOpen: true, openingFee: 0n, room: null, rent: null, walletCap: null, spendMax: null, tokens: [] }
      waited += after
      await sleep(after)
    }
    const c = await r.json()
    const rent: RentTerms | null = c.rent_per_month
      ? { perMonth: Number(c.rent_per_month), least: BigInt(c.rent_room_min), most: BigInt(c.rent_room_max), monthMs: Number(c.rent_month_seconds) * 1000 }
      : null
    const walletCap: WalletCap | null =
      c.code === 'wallet_cap' || c.code === 'wallet_cap_unknown'
        ? {
            code: c.code,
            open: typeof c.wallet_open === 'number' ? c.wallet_open : null,
            most: Number(c.wallet_most),
            channels: (Array.isArray(c.wallet_channels) ? c.wallet_channels : []).map((x: { opened?: number | null; funded?: number | string | null }) => ({
              opened: typeof x?.opened === 'number' ? x.opened * 1000 : null,
              funded: x?.funded == null ? null : BigInt(x.funded),
            })),
          }
        : null
    const spendMax = Number.isSafeInteger(c.spend_max) && c.spend_max >= 100_000_000 ? BigInt(c.spend_max) / 100_000_000n : null
    const tokens: TokenTerms[] = Object.entries((c.tokens ?? {}) as Record<string, Record<string, unknown>>).map(([name, t]) => ({
      name,
      script: t.script as FiberScript,
      decimals: Number(t.decimals ?? 8),
      room: BigInt((t.room as number) ?? 0),
      openingFee: big(t.opening_fee),
      spendMax: big(t.spend_max),
      held: big(t.held),
      channelsLeft: typeof t.channels_left === 'number' ? t.channels_left : null,
      canOpen: t.can_open === true,
      cellDep: t.cell_dep ?? null,
      linkMost: typeof t.link_most === 'number' && t.link_most > 0 ? t.link_most : LINK_MOST,
    }))
    return { canOpen: c.can_open !== false, openingFee: BigInt(c.opening_fee ?? 0), room: c.room == null ? null : BigInt(c.room), rent, walletCap, spendMax, tokens }
  } catch {
    return { canOpen: true, openingFee: 0n, room: null, rent: null, walletCap: null, spendMax: null, tokens: [] }
  }
}

/** A rent, by its invoice's payment hash, as the LSP's gateway says it now. */
export async function rentStatus(gateway: string, paymentHash: string): Promise<RoomRent> {
  const r = await fetch(`${gateway}/rent/${paymentHash}`)
  const b = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(b.error ?? `the LSP answered ${r.status}`)
  const ms = (x: number | null) => (x == null ? null : x * 1000)
  return { paymentHash, room: BigInt(b.room), months: b.months, price: BigInt(b.price), paid: !!b.paid, start: ms(b.start), until: ms(b.until), ended: !!b.ended, closed: !!b.closed }
}

/** Whether the LSP's wallet can put in its side of one more channel, as its gateway counts it. */
export async function lspHasRoom(gateway: string): Promise<boolean> {
  try {
    const r = await fetch(`${gateway}/capacity`)
    return r.ok ? (await r.json()).can_open !== false : true
  } catch {
    // Not known: the opening itself says if there is no room.
    return true
  }
}

export class FiberSession {
  state: FiberState = { phase: 'off', tenantId: null, channelId: null, channel: null, opening: false, closing: false, kept: false, behind: false, rekeep: false, unfunded: false, link: null, linkKey: null, feeDue: 0n, idleCloseAt: null, brought: false, stuck: null, unanswered: false, left: null, asideChecking: false, asideBack: [], status: '', log: [] }
  private listeners = new Set<() => void>()
  private wasm?: typeof import('./signer/cellula_lsp_signer.js')
  private signer?: LspSigner
  /** The records the host's watcher last took (passToWatcher). */
  private watched = ''
  private token = ''
  // When the token's end was last looked at (renewToken).
  private renewChecked = 0
  // Payments made without the passkey lately (stepup.ts).
  private quiet: Quiet = []
  // The opening fee's own payment is under way (payOpeningFee): pay() does not ask for it again.
  private feeRun: Promise<string | null> | null = null
  // The channel whose close for being unused was approved here (approveIdleClose).
  private idleApproved: string | null = null
  /** The rate the gateway fixed for this channel's idle close (hello's `idle_close_fee_rate`, said
   * to a page that says `close_fee_rates`); null while it says none, and the close goes at 1,000. */
  private idleCloseFeeRate: number | null = null
  // Stopped by pagehide while the page itself stayed: started again once it is seen (beat).
  private gone = false
  // What the chain said of a closing channel's funding cell, by outpoint (closedOnChain).
  private chainSaid = new Map<string, { at: number; spent: boolean; settled: boolean; forced: boolean }>()
  // When the chain was last asked whether the funding kept here can reach it, and when it first said
  // it cannot (fundingNeverLands).
  private landAsked = 0
  private landLost: { funding: string; since: number } | null = null
  // Asks for an invoice made on the spot already answered (answerAsks), for a minute each.
  private asked = new Set<string>()
  private tenantId = ''
  private backupKey?: CryptoKey
  // The backup of the signer's last save, sealed and not sent yet (signerHost.save): it goes with
  // the signature that follows (signWithBackup), or alone before any other call (backupFirst).
  private backupDue: BackupDue | null = null
  // A backup on its way alone, or with a signature: nothing else goes to the LSP before it ends.
  private backupSending: Promise<void> = Promise.resolve()
  private backupTimer: ReturnType<typeof setTimeout> | null = null
  // The gateway takes a backup with a signature (/sign); false once it said 404 (an older one).
  private signsWithBackup = true
  // The passkey's access code: the gateway hands the backup only to whoever has it.
  private access?: string
  // Sealed at rest, kept here in the clear while the host runs: the invoices with their
  // secrets, and the key the pay link's invoices are signed with.
  private inv: Invoice[] = []
  private saving: Promise<void> = Promise.resolve()
  private linkKey: string | null = null
  private channelId: string | null = null
  private running = false
  private joining = false
  /** Set by `recovery()`: this device leaves the channel on its own, so no start may join the LSP and
   * sign on. One waiting at `join()` for a gateway that did not answer would have signed newer states
   * once it came back, while the recovery holds the older one it read, and publishing that copy would
   * hand the LSP the whole channel. */
  private leaving = false
  // Hidden after saying bye: the loop asks nothing until the page is back and has said hello, or its
  // next call took the lease again and woke the tenant at the LSP (2026-10-13).
  private away = false
  // Fast for a while after anything moved; woken at once by a payment from here.
  private busyUntil = 0
  private wakeUp: (() => void) | null = null
  // The gateway's count of this tenant's changes at the LSP, as last heard (watch); and whether one
  // came that no round has read yet.
  private watchtowerNone = new Map<string, { at: number; answer: string }>()
  private nextStatus = new Map<string, { at: number; answer: string }>()
  // The network's part of a call to the gateway, about (submitSignature); 20 ms until heard.
  private tripMs = 20
  private tripHeard = false
  private seen = -1
  private woken = false
  private watching = false
  // The gateway hears the LSP's changes (watch): a payment's rounds need no clock of their own.
  private hearing = false
  private afterRound: (() => void)[] = []
  // Since when the signer has refused the channel's request and signed nothing; 0 while it signs.
  private refusingSince = 0
  // The LSP was asked to close this channel by force (askClose), until it is closed.
  private forcing = false
  private booting?: Promise<void>
  private lastChannel = 0
  private lastInvoiceCheck = 0
  private linkInvoicesChecked = 0
  /** Channels of a token whose name was asked of the gateway this run (learnToken). */
  private tokenAsked = new Set<string>()
  /** The payments coming in, by hash, as the channel's TLCs last said (comingIn). */
  private incoming: Set<string> | null = new Set()
  private linkChecked = 0
  private linkBusy = false
  /** The link's entries already signed, by invoice hash, for the tenant and key in linkSignedBy: an
   * invoice does not change, so a round reads and signs only the new ones. Reading and signing all
   * of them every minute froze the page about 300 ms (a tester's phone, 2026-10-25: 124 invoices). */
  private linkSigned = new Map<string, { invoice: string; sig: string }>()
  private linkSignedBy: { id: string; key: string } | null = null
  private lastNote = { text: '', times: 0 }
  private paidListeners = new Set<(paymentHash: string, amount: bigint) => void>()
  private sentListeners = new Set<(paymentHash: string, paid: boolean) => void>()
  private device = ''
  // This page, named in its hello and its bye: on a reload the bye of the page that went reached the
  // gateway after the hello of the page that came and undid it, two 409s and the tenant evicted. The gateway lets go of a bye from a page it no longer greets.
  private page = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
  // The channels set aside here that their last round found still open, by suffix (settleAside), and
  // the first rounds of those set aside before this page, once all are in.
  private asideOpen = new Map<string, string>()
  private asideFirst: Promise<void> = Promise.resolve()
  private bringing = false
  // This page's own ask of the channels set aside (checkAside), which holds the signing lock while it
  // runs: a start waits for it instead of taking it for another tab (a tester's phone, 2026-10-27: a top-up
  // tapped while it ran said "open in another tab of this browser").
  private checking: Promise<boolean> | null = null
  private readonly store: Store

  constructor(
    private readonly host: Host,
    protected readonly config: FiberConfig,
  ) {
    this.store = host.store
    this.delay = channelDelay(config.delayEpochs)
  }

  /** The delay of new channels and what it asks of their payments (delay.ts). */
  readonly delay: ChannelDelay

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<FiberState>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  private say(status: string) {
    this.set({ status })
  }

  /** A line in the log; the same line again bumps a counter instead of filling it. */
  log(text: string) {
    const stamp = new Date().toISOString().slice(11, 19)
    const log = [...this.state.log]
    if (text === this.lastNote.text && log.length) {
      log[0] = `${stamp} ${text} (x${++this.lastNote.times})`
    } else {
      this.lastNote = { text, times: 1 }
      log.unshift(`${stamp} ${text}`)
    }
    this.set({ log: log.slice(0, 40) })
  }

  private async read<T>(name: string, empty: T): Promise<T> {
    const value = await this.store.get(name)
    return value === undefined ? empty : (JSON.parse(value) as T)
  }

  /** 'testnet' or 'mainnet', from the signer once its chain is configured. */
  private network: string | null = null
  private sentList = () => this.read<Sent[]>(SENT, [])
  private sentSaving: Promise<void> = Promise.resolve()
  /** One write of the sent list at a time, each from the list as it is when its turn comes: a
   * payment added while another resolved was dropped by the older copy written back, and its settlement then refused. */
  private editSent(edit: (list: Sent[]) => Sent[]): Promise<void> {
    const run = this.sentSaving.then(async () => this.store.set(SENT, JSON.stringify(edit(await this.sentList()))))
    this.sentSaving = run.catch(() => {})
    return run
  }

  /** The last backup version this host wrote or restored; 0 when it keeps none. */
  private backupVersion = async (): Promise<number> => (await this.read<{ version: number }>(VERSION, { version: 0 })).version
  private setBackupVersion = (version: number) => this.store.set(VERSION, JSON.stringify({ version }))

  private async deviceId(): Promise<string> {
    const kept = await this.store.get(DEVICE)
    if (kept) return kept
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
    await this.store.set(DEVICE, id)
    return id
  }

  // The genesis block's hash, as the endpoint said it (the signer asks it first, to tell the chain).
  private genesisHash: string | null = null
  /** The CKB calls of this host. The genesis block never changes, and the signer reads it at every
   * start for the hash of its second transaction (lsp-signer chain.rs settlement_deps): 2.3 MB on
   * testnet, 5.4 s of a checkout's 8 s wait for the wallet's tab. Kept once per genesis the endpoint names, cut to what the signer reads (genesisCut). */
  private ckbCall = async (method: string, params: string): Promise<string> => {
    const genesis = params.replace(/\s/g, '') === '["0x0"]'
    const name = genesis && method === 'get_block_by_number' && this.genesisHash ? `${GENESIS}:${this.genesisHash}` : null
    if (name) {
      const kept = await this.store.get(name).catch(() => undefined)
      if (kept) return kept
    }
    const out = await ckbCaller(this.config.ckbNodes)(method, params)
    if (genesis && method === 'get_block_hash') this.genesisHash = genesisHashOf(out)
    const cut = name ? genesisCut(out, this.genesisHash!) : null
    if (name && cut) await this.store.set(name, cut).catch(() => {})
    return out
  }

  // What the signer calls out to. It reads the JSON-RPC envelopes itself.
  private signerHost = {
    lsp: (method: string, params: string, token?: string) =>
      method === 'get_watchtower_signing_status' ? this.watchtowerAsk(params, token)
      : method === 'submit_channel_signature' ? this.submitSignature(params, token)
      : method === 'get_channel_signing_status' ? this.channelAsk(params, token)
      : this.lspCall(method, params, token),
    ckb: (method: string, params: string) => this.ckbCall(method, params),
    // The signer saves before the LSP sees any signature. The backup of that state is sealed here
    // and goes with the signature, in one request that the gateway keeps first and sends on only
    // then (signWithBackup); before any other call, alone (backupFirst). If it cannot be written,
    // nothing after it is sent, so the backup is never behind what the LSP has heard. One round
    // trip less for each signature: about a second of a payment at 80 ms a call (LSP2, 2026-10-30).
    save: async (state: string) => {
      await this.store.set(STATE, state, SEALED)
      const due = await this.sealBackup(state)
      if (!due) return
      this.backupDue = due
      this.backupSoon()
    },
  }

  private async post(url: string, body: string, token?: string, more: Record<string, string> = {}): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device': this.device, ...(token ? { authorization: `Bearer ${token}` } : {}), ...more },
      body,
    })
  }

  private async lspCall(method: string, params: string, token?: string, more?: Record<string, string>): Promise<string> {
    const body = envelope(method, params)
    await this.backupFirst()
    for (let attempt = 0; ; attempt++) {
      try {
        return await (await this.post(`${this.config.gateway}/rpc`, body, token, more)).text()
      } catch (e) {
        if (!READS.has(method) || attempt >= 3) throw e
        await sleep(500 * (attempt + 1))
      }
    }
  }

  /** A signature, and the channel's next signing request with it: the gateway reads it as the LSP
   * makes it, waiting up to about one round trip from here, and the signer's next read of that
   * channel takes it (channelAsk) instead of asking again over the network. A request waits for
   * this signer once made, so a read taken then is as good as one taken a round trip later; one
   * that said none only ends this round sooner, and the change that follows wakes the next (watch).
   * A round trip less a signature: 12 of a payment's (dev chain, 2026-10-30). The wait asked is
   * the network's part of a call, the gateway's own time (`served_ms`) taken out: counted whole, a
   * busy LSP's slowness held every signature, and 50 payments across two LSPs paid 25% fewer. */
  private async submitSignature(params: string, token?: string): Promise<string> {
    const sent = Date.now()
    const more = { 'x-next-wait-ms': String(Math.max(1, Math.min(250, Math.round(this.tripMs)))) }
    const answer = (await this.signWithBackup(params, token, more)) ?? (await this.lspCall('submit_channel_signature', params, token, more))
    let body: { next_status?: unknown; served_ms?: unknown }
    try {
      body = JSON.parse(answer)
    } catch {
      return answer
    }
    if (body.next_status === undefined) return answer
    if (typeof body.served_ms === 'number') {
      const trip = Math.max(0, Date.now() - sent - body.served_ms)
      this.tripMs = this.tripHeard ? 0.8 * this.tripMs + 0.2 * trip : trip
      this.tripHeard = true
    }
    const channel = channelOf(params)
    if (channel) this.nextStatus.set(channel, { at: Date.now(), answer: JSON.stringify(body.next_status) })
    delete body.next_status
    delete body.served_ms
    return JSON.stringify(body)
  }

  /** A channel's signing request, from the last signature's answer once (submitSignature), while
   * fresh; else asked. */
  private async channelAsk(params: string, token?: string): Promise<string> {
    const channel = channelOf(params)
    const kept = channel ? this.nextStatus.get(channel) : undefined
    if (channel) this.nextStatus.delete(channel)
    if (kept && Date.now() - kept.at < NEXT_STATUS_MS) return kept.answer
    return this.lspCall('get_channel_signing_status', params, token)
  }

  /** The signer asks each round whether the LSP's watchtower has a settlement for it to sign. One
   * comes after a channel closed by force, and waits hours for this signer, not seconds: an answer
   * that none waits is kept WATCHTOWER_NONE_MS. Read every round, it was a third of a payment's calls
   * in a row, a second of it at a phone's 80 ms (dev chain, 2026-10-30). */
  private async watchtowerAsk(params: string, token?: string): Promise<string> {
    const kept = this.watchtowerNone.get(params)
    if (kept && Date.now() - kept.at < WATCHTOWER_NONE_MS) return kept.answer
    const answer = await this.lspCall('get_watchtower_signing_status', params, token)
    const none = /"result"/.test(answer) ? !/"SignatureRequired"/.test(answer) : /watched channel not found/.test(answer)
    if (none) this.watchtowerNone.set(params, { at: Date.now(), answer })
    else this.watchtowerNone.delete(params)
    return answer
  }

  private async lsp<T>(method: string, params: unknown): Promise<T> {
    if (Date.now() - this.renewChecked > RENEW_CHECK_MS) await this.renewToken(false)
    let body = JSON.parse(await this.lspCall(method, JSON.stringify(params), this.token))
    // A token that ended while the page was away: renewed now, and the call asked once more.
    if (body.error && TOKEN_REFUSED.test(body.error.message ?? '') && (await this.renewToken(true))) {
      body = JSON.parse(await this.lspCall(method, JSON.stringify(params), this.token))
    }
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
    return body.result as T
  }

  /** Renews the tenant token a week before it ends, or now when `force` (the LSP refused it): a new
   * proof of the same root key, for the LSP the config names; the LSP keeps the tenant and its
   * channels. Returns whether it renewed. A signer that cannot renew (no `renew`, the LSP2 line)
   * and a renewal that fails are logged; the token kept is used until the LSP refuses it. */
  private async renewToken(force: boolean): Promise<boolean> {
    this.renewChecked = Date.now()
    const signer = this.signer as (LspSigner & { renew?: (lsp: string, force: boolean) => Promise<string> }) | undefined
    if (!signer?.renew || !this.token) return false
    try {
      const r = JSON.parse(await signer.renew(this.config.lspPubkey, force)) as { renewed: boolean; expires_at_ms?: number | null }
      if (!r.renewed) return false
      this.token = JSON.parse(await signer.status()).tenant_token
      this.log(`Renewed the channel's access at the LSP, good until ${r.expires_at_ms ? new Date(r.expires_at_ms).toISOString().slice(0, 10) : 'its end'}.`)
      return true
    } catch (e) {
      this.log(`The channel's access at the LSP was not renewed: ${message(e)}`)
      return false
    }
  }

  /** One write at a time, each from the list as it is when its turn comes: two seals in flight
   * could land out of order and drop an invoice made in between, its secret with it. */
  private saveInvoices(): Promise<void> {
    const run = this.saving.then(() => this.store.set(INVOICES, JSON.stringify(this.inv), SEALED))
    this.saving = run.catch(() => {})
    return run
  }

  /** Before money moves out (a close, a payment over stepUpCkb): the passkey that keeps this
   * channel, when it has one. A channel kept with no passkey lives in this host alone and has
   * nothing to ask. */
  private async stepUp() {
    // Kept with a passkey (a backup version) though its key is not here, as one brought back from
    // aside whose key the keeper does not hold: asked all the same, which gives the key back.
    if (!this.host.keeper || !(this.backupKey || (await this.backupVersion()))) return
    // The passkey keeps the newest backup version as it is used.
    const unlocked = await this.host.keeper.unlock(this.tenantId, await this.backupVersion())
    if (unlocked.tenantId !== this.tenantId) throw new Error('that passkey keeps another channel')
    this.backupKey = unlocked.key
    this.access = unlocked.access
  }

  /** The preimages of the invoices whose payments may still sit in a channel, those made here and
   * those a backup brought: what a recovery claims a payment held for this side with. `aside`: the
   * suffix of a channel set aside (setAside), whose own are kept under it. */
  private async keptPreimages(aside = ''): Promise<Record<string, string>> {
    const kept: Record<string, string> = JSON.parse((await this.store.get(PREIMAGES + aside, SEALED)) ?? '{}')
    const made: Invoice[] = !aside && this.inv.length ? this.inv : JSON.parse((await this.store.get(INVOICES + aside, SEALED)) ?? '[]')
    const since = Date.now() - PREIMAGE_KEPT_MS
    for (const i of made) if (i.preimage && (i.expires_at ?? Date.now()) > since) kept[i.payment_hash] = i.preimage
    return kept
  }

  /** A backup's content, here: the signer's state, and the preimages it brought beside the ones kept.
   * A copy written by a channel brought from its backup makes this one brought too (packBackup). */
  private async takeBackup(opened: string, tenantId = this.tenantId) {
    // A newer copy replaces the state here: what was sealed from the old one is not sent.
    this.backupDue = null
    const { state, preimages, brought } = unpackBackup(opened)
    // A copy from the gateway is only as new as the gateway says, until the LSP greets it.
    await this.store.set(VERDICT, 'restored')
    await this.store.set(STATE, state, SEALED)
    const kept: Record<string, string> = JSON.parse((await this.store.get(PREIMAGES, SEALED)) ?? '{}')
    await this.store.set(PREIMAGES, JSON.stringify({ ...kept, ...preimages }), SEALED)
    if (brought && tenantId) await this.store.set(BROUGHT, tenantId)
  }

  private async backUp(state: string) {
    const due = await this.sealBackup(state)
    if (due) await this.putBackup(due)
  }

  /** The backup of `state`, sealed for the gateway as the next version; null with nothing to keep it. */
  private async sealBackup(state: string): Promise<BackupDue | null> {
    const keeper = this.host.keeper
    if (!keeper || !this.backupKey || !this.token || !this.tenantId) return null
    const version = (await this.backupVersion()) + 1
    const brought = (await this.store.get(BROUGHT)) === this.tenantId
    const sealed = await keeper.seal(this.backupKey, this.tenantId, version, packBackup(state, await this.keptPreimages(), brought))
    return { version, tenant: this.tenantId, token: this.token, body: { version, ...sealed, owner: (await this.store.get(OWNER)) ?? undefined, access_hash: this.access ? await accessHash(this.access) : undefined } }
  }

  private async putBackup(due: BackupDue) {
    const r = await this.post(`${this.config.gateway}/backup/put`, JSON.stringify(due.body), due.token)
    const body = await r.json()
    if (!r.ok) throw new Error(`the backup was not kept: ${body.error}`)
    await this.backupKept(due.version)
  }

  private async backupKept(version: number) {
    await this.setBackupVersion(version)
    this.set({ kept: true })
  }

  /** The backup still due, sent alone, and any on its way, kept: before a call, so the LSP hears
   * nothing of a state the backup does not have. Throws, and the call is not made, when it was not
   * kept; it stays due and goes first again. */
  private async backupFirst() {
    for (;;) {
      const sending = this.backupSending
      await sending
      // Another began meanwhile: that one first.
      if (this.backupSending !== sending) continue
      const due = this.backupDue
      if (!due) return
      // Taken and its sending set in one step, with nothing awaited between: a call made meanwhile
      // waits for it (two at once, the second went out before the backup was kept).
      this.backupDue = null
      const put = (async () => {
        if (!(await this.stale(due))) await this.putBackup(due)
      })().catch((e) => {
        this.backupDue ??= due
        throw e
      })
      this.backupSending = put.catch(() => {})
      return put
    }
  }

  /** Whether `due` was sealed before the channel kept here changed, set aside or replaced by a newer
   * copy: then it is dropped, never sent over it. */
  private async stale(due: BackupDue): Promise<boolean> {
    if (due.tenant === this.tenantId && (await this.backupVersion()) === due.version - 1) return false
    this.log(`A backup sealed as version ${due.version} was not sent: the channel kept here changed since.`)
    return true
  }

  /** A save with no call after it (an authorization, a nonce), backed up all the same soon after. */
  private backupSoon() {
    if (this.backupTimer) return
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null
      if (this.backupDue) this.backupFirst().catch((e) => this.log(`The backup was not kept: ${message(e)}`))
    }, BACKUP_ALONE_MS)
  }

  /** A signature with the backup due, in one request (gateway /sign): the gateway keeps the backup
   * and only then sends the signature on, its answer as /rpc gives it. Null when no backup is due,
   * or the gateway is older and has no /sign (the backup then goes alone first, lspCall). */
  private async signWithBackup(params: string, token: string | undefined, more: Record<string, string>): Promise<string | null> {
    for (;;) {
      const sending = this.backupSending
      await sending
      if (this.backupSending !== sending) continue
      const due = this.backupDue
      if (!due || !this.signsWithBackup || due.token !== token) return null
      this.backupDue = null
      const call = (async () => {
        if (await this.stale(due)) return null
        let r: Response
        try {
          r = await this.post(`${this.config.gateway}/sign`, `{"backup":${JSON.stringify(due.body)},"rpc":${envelope('submit_channel_signature', params)}}`, token, more)
        } catch (e) {
          this.backupDue ??= due
          throw e
        }
        if (r.status === 404) {
          this.signsWithBackup = false
          this.backupDue ??= due
          return null
        }
        const body = (await r.json().catch(() => ({}))) as { backup_version?: unknown; answer?: unknown; error?: unknown }
        if (body.backup_version !== due.version) {
          this.backupDue ??= due
          throw new Error(`the backup was not kept: ${typeof body.error === 'string' ? body.error : `HTTP ${r.status}`}`)
        }
        await this.backupKept(due.version)
        return JSON.stringify(body.answer)
      })()
      this.backupSending = call.then(() => {}, () => {})
      return call
    }
  }

  /** Start the signer here: once, and only while no other signer of this host runs it. The first
   * start registers a tenant with the LSP. Where another tab runs it, this one waits behind it and
   * starts by itself when that tab closes (a checkout window opened beside the wallet's tab sat
   * there with nothing to press, 2026-10-12); the lock passes from one to the other, never shared. */
  start(): Promise<void> {
    if (!this.booting) {
      this.booting = (async () => {
        await this.checking?.catch(() => false)
        // That check found one set aside still open: the host starts again with it (bringBack).
        if (this.bringing) return
        const lock = await this.host.acquire(this.config.lockName)
        if (lock.held) return this.boot(lock)
        if (lock.why === 'unsupported') return this.set({ phase: 'failed', status: 'This browser cannot keep the channel to one tab, so it does not open here.' })
        this.set({ phase: 'elsewhere', status: 'Your Fiber channel is open in another tab of this browser. Close that tab and this one carries on by itself.' })
        this.host.wait?.(this.config.lockName).then(
          (later) => {
            if (!later.held) return
            this.booting = this.boot(later)
            this.booting.catch(() => {})
          },
          () => {},
        )
      })()
    }
    return this.booting
  }

  private async boot(lock: { release(): void }) {
    try {
      await this.init()
    } catch (e) {
      this.set({ phase: 'failed', status: `The channel's signer did not start: ${message(e)}` })
      lock.release()
      throw e
    }
  }

  private async init() {
    this.set({ phase: 'starting', status: "Starting your channel's signer…", left: await this.keptLeft() })
    this.device = await this.deviceId()
    this.wasm = await import('./signer/cellula_lsp_signer.js')
    await this.host.initSigner(this.wasm.default)
    // What this host keeps sealed; anything kept before sealing is sealed now.
    let state: string | undefined
    try {
      state = await this.store.get(STATE, SEALED)
      this.inv = JSON.parse((await this.store.get(INVOICES, SEALED)) ?? '[]')
      this.linkKey = (await this.store.get(LINK_KEY, SEALED)) ?? null
      this.quiet = (JSON.parse((await this.store.get(QUIET, SEALED)) ?? '[]') as { at: number; amount: string }[]).map((p) => ({ at: p.at, amount: BigInt(p.amount) }))
    } catch (e) {
      if (e instanceof VaultKeyLost) this.set({ behind: true })
      throw e
    }
    this.signer = await this.wasm.LspSigner.create(this.signerHost, state)
    const status = JSON.parse(await this.signer.register(this.config.lspPubkey))
    this.tenantId = status.tenant_id
    this.token = status.tenant_token
    await this.renewToken(false)
    // Not for a channel just brought back from aside: the key kept here may be another's (afterBack).
    if (this.host.keeper && (await this.backupVersion()) && (await this.store.get(BACK)) !== this.tenantId) {
      const kept = await this.host.keeper.stored()
      this.backupKey = kept.key
      this.access = kept.access
    }
    // The network as the endpoint's genesis block says it (the signer's chain check).
    this.network = JSON.parse(await this.signer.configureChain()).network ?? null
    await this.tellTokens()
    this.channelId = status.bound_channel_ids[0] ?? null
    if (this.channelId && !(await this.store.get(OWNER))) await this.store.set(OWNER, this.config.ownerKey(scriptHash(JSON.parse(await this.signer.openingRequest()).shutdown_script)))
    this.set({
      tenantId: this.tenantId,
      channelId: this.channelId,
      kept: !!this.backupKey,
      rekeep: !!this.backupKey && !this.access,
      link: (await this.store.get(LINK_ON)) ? this.tenantId.slice(0, 12) : null,
      linkKey: this.linkKey && this.config.link ? this.config.link.publicKey(this.linkKey as Hex) : null,
    })
    await this.retireIfBrought()
    await this.passToWatcher()
    this.listen()
    await this.protect()
    // Channels set aside here: until they say whether one is still open, an empty balance is not
    // known (settleAside answers it). Not for a tenant registered just now, for a top-up: its page
    // knows it holds none, and Home's row waited a second in its outline as the top-up started (seen
    // on a test build). open() itself waits for their answer.
    if (state !== undefined && (await this.store.names(`${STATE}-closed-`)).length) this.set({ asideChecking: true })
    await this.run()
    // Also for a channel known closed whose page stopped signing (closedOnChain reads its recovery,
    // which stops it): the one set aside that is still open comes back then too.
    if (this.running || this.notOpenHere()) void this.settleAside()
    else this.set({ asideChecking: false })
  }

  /** Hands the host's watcher this channel's records, when the host has one and they changed since
   * it last took them. A watcher that fails is told again next time; the channel goes on. */
  private async passToWatcher() {
    const host = this.host
    if (!host.watch || !this.channelId || !this.signer?.watchRecords) return
    try {
      const records = await this.signer.watchRecords(this.channelId)
      if (records === this.watched) return
      await host.watch(this.channelId, records)
      this.watched = records
    } catch (e) {
      this.log(`Watcher: ${message(e)}`)
    }
  }

  /** A brought channel's signer is marked restored before it signs anything, so no channel in its
   * store signs again: it is only closed. The page then asks the LSP to close the channel by force (the gateway's close-stuck,
   * `brought`); until the gateway took that ask, this runs again at each start. A signer that cannot
   * be marked does not start. */
  private async retireIfBrought() {
    const brought = !!this.tenantId && (await this.store.get(BROUGHT)) === this.tenantId
    this.set({ brought })
    if (!brought || !this.channelId || (await this.store.get(RETIRE)) !== this.tenantId) return
    await this.signer!.markRestored()
    let why = ''
    try {
      const r = await this.post(`${this.config.gateway}/close-stuck`, JSON.stringify({ brought: true }), this.token)
      if (!r.ok) why = (await r.json().catch(() => ({}))).error ?? `the gateway answered ${r.status}`
    } catch (e) {
      why = message(e)
    }
    if (why) {
      this.log(`brought from its backup: this copy signs nothing again; the LSP has not been asked to close it yet (${why})`)
      return
    }
    await this.store.remove(RETIRE)
    this.log('brought from its backup: this copy signs nothing again, and the LSP closes the channel by force')
  }

  /** Why leaving without the LSP is refused for the copy kept here, or null when it is not. */
  private async leaveRefusal(): Promise<string | null> {
    if (await this.store.get(BROUGHT))
      return 'This channel was brought here from its backup, which may be older than its last state: closing it on your own could lose the whole balance. Close it together with the LSP.'
    const verdict = await this.store.get(VERDICT)
    if (this.state.behind || verdict === 'stale' || verdict === 'restored')
      return 'This copy of your channel may be older than the one the LSP last saw, and closing with it can lose the whole balance. Close it from the device you used last, or from your newest recovery file.'
    if (verdict === 'elsewhere') return 'Your channel was last open on another device. Close it from there, or from your newest recovery file.'
    return null
  }

  // Away means away: a closed or hidden page says bye, so the LSP holds payments instead of
  // sending them to a channel whose signer cannot answer, and another device may take over.
  private listen() {
    const presence = this.host.presence
    presence.onAway((why) => {
      if (why === 'gone') {
        this.running = false
        this.gone = true
        this.bye()
        return
      }
      if (this.running && !this.state.opening && !this.state.closing && !this.state.channel?.receiving) {
        this.away = true
        this.bye()
      }
    })
    presence.onBack(async (why) => {
      if (why === 'restored' || (!this.running && this.gone)) return this.again()
      if (!this.running) return
      await this.holdScreen()
      const greeted = await this.hello()
      this.away = false
      if (!greeted.ok) return this.rejoin()
      // Back: what waited for a signature while away is asked for now.
      this.stir()
    })
    setInterval(() => void this.beat(), 2000)
  }

  /** A page stopped by pagehide and seen again: started once more (run greets the gateway). */
  private again() {
    this.gone = false
    if (this.token) void this.run()
  }

  /** Every 2 s while the page is seen: still here at the gateway, greeted again if not. A page
   * stopped by pagehide that is seen again starts once more, and one back from hidden that the
   * browser said nothing of goes on (a tester's phone, 2026-10-14: the app's page was on screen again with
   * neither event, its session stopped since 08:12, and the quick balance kept showing a channel
   * that was closed and paid out). */
  private async beat() {
    if (!this.host.presence.visible()) return
    if (!this.running) {
      if (this.gone) this.again()
      return
    }
    try {
      const r = await this.post(`${this.config.gateway}/here`, '{}', this.token)
      if (r.status === 409) return this.rejoin()
      const here = await r.json()
      // An unused channel's date comes here too: a page left open never says hello again.
      if ('idle_close_at' in here) {
        const at = here.idle_close_at ? here.idle_close_at * 1000 : null
        if (at !== this.state.idleCloseAt) this.set({ idleCloseAt: at })
        this.idleCloseFeeRate = typeof here.idle_close_fee_rate === 'number' ? here.idle_close_fee_rate : null
      }
      if (here.present) return
      if (!(await this.hello()).ok) return this.rejoin()
      if (this.away) {
        this.away = false
        this.stir()
      }
    } catch {
      // the next beat tries again
    }
  }

  private bye() {
    if (this.token) this.host.presence.beacon(`${this.config.gateway}/bye`, JSON.stringify({ token: this.token, device: this.device, page: this.page }))
  }

  /** Tell the gateway the signer is here, so it brings the tenant back. Refused while another
   * device signs, or when this copy is older than the backup. */
  private async hello(): Promise<{ ok: boolean; stale?: boolean; elsewhere?: boolean; unanswered?: boolean; version?: number }> {
    try {
      // close_fee_rates: this page approves an idle close at the rate the gateway says (approveIdleClose).
      const r = await this.post(`${this.config.gateway}/hello`, JSON.stringify({ backup_version: await this.backupVersion(), page: this.page, close_fee_rates: true }), this.token)
      const body = await r.json().catch(() => ({}))
      this.log(`Hello: tenant ${body.runtime_status ?? body.error ?? r.status}.`)
      const verdict = r.ok ? 'ok' : r.status === 409 ? (body.stale ? 'stale' : 'elsewhere') : null
      // A token channel owes its fee in the token (fee_due_token), in the units of its balance.
      if (r.ok) this.set({ feeDue: BigInt(body.fee_due_token ?? body.fee_due ?? 0), idleCloseAt: body.idle_close_at ? body.idle_close_at * 1000 : null })
      if (r.ok) this.idleCloseFeeRate = typeof body.idle_close_fee_rate === 'number' ? body.idle_close_fee_rate : null
      if (verdict) await this.store.set(VERDICT, verdict)
      return { ok: r.ok, stale: r.status === 409 && !!body.stale, elsewhere: r.status === 409 && !body.stale, unanswered: r.status >= 500, version: typeof body.backup_version === 'number' ? body.backup_version : undefined }
    } catch (e) {
      this.log(`Hello failed: ${message(e)}`)
      return { ok: false, unanswered: true }
    }
  }

  private async run() {
    if (this.running || this.joining) return
    this.joining = true
    try {
      if (!(await this.join())) return
    } finally {
      this.joining = false
    }
    this.running = true
    // Joined: greeted, so here again, whatever hid it before.
    this.away = false
    this.set({ phase: 'running' })
    if (this.channelId) this.say('Checking whether anything waits for your signature.')
    else this.say('')
    await this.refreshChannel(true).catch(() => {})
    await this.tick()
    void this.watch()
    void (async () => {
      while (this.running) {
        await this.nap(this.nextTick())
        // A page that left during the wait asks nothing more: one more call woke its tenant at the
        // LSP after its bye, and a payment then went to a signer that was gone (nightly, 2026-10-13).
        if (!this.running) break
        if (this.away) continue
        await this.tick()
      }
    })()
  }

  /** How long the loop waits before its next round: 250 ms while money comes in, 1 s while an
   * opening, a close or a payment of this side is under way or for BUSY_MS after anything was
   * signed, else IDLE_TICK_MS (or the config's idleTickMs). Idle at 1 s, an open app asked the
   * gateway about twice a second, the largest cost of the app on mobile data (a tester's phone, 2026-10-13).
   * While the gateway hears the LSP's changes (watch), a payment's rounds come from them, and the
   * clock is IDLE_TICK_MS outside an opening or a close. */
  private nextTick(): number {
    if (this.config.loopFloorMs !== undefined) return this.config.loopFloorMs
    if (this.calm()) return STUCK_TICK_MS
    const c = this.state.channel
    const settingUp = this.state.opening || this.state.closing || (c && !c.ready)
    // Heard (watch): each change of a payment wakes the loop itself; the clock only catches one missed.
    if (this.hearing && !settingUp) return this.config.idleTickMs ?? IDLE_TICK_MS
    if (c?.receiving) return 250
    if (settingUp || (c && c.going > 0n) || Date.now() < this.busyUntil) return 1000
    return this.config.idleTickMs ?? IDLE_TICK_MS
  }

  /** After a round: whether its signer refused the channel's request and signed nothing. Past
   * STUCK_AFTER_MS of that the channel is stuck (state.stuck); a round that signs, or refuses
   * nothing, ends it. */
  private refusing(refused: boolean) {
    if (!refused) {
      this.refusingSince = 0
      if (this.state.stuck) this.set({ stuck: null })
      return
    }
    this.refusingSince ||= Date.now()
    if (!this.state.stuck && !this.forcing && Date.now() - this.refusingSince >= STUCK_AFTER_MS) {
      this.set({ stuck: { since: this.refusingSince } })
      this.log('Stuck: the signer cannot give the signature this channel waits for, so no payment in it finishes. The LSP can close it by force.')
    }
  }

  /** Refusing for REFUSING_CALM_MS: the rounds and the LSP's changes are followed on STUCK_TICK_MS. */
  private calm(): boolean {
    return this.refusingSince > 0 && Date.now() - this.refusingSince >= REFUSING_CALM_MS
  }

  /** Have the LSP close this channel by force, while a signature waits in it that its signer cannot
   * give (state.stuck): the way out of it. The CKB comes back to the wallet on chain, this side's
   * share once the chain allows, and a payment that was in it once it ends. */
  /** Give up an opening whose funding the wallet signed and which is not on chain: refused by the
   * pool, or waiting in a full one. The wallet spends a coin the funding spends back to itself, at
   * what the pool asks, and in a pool still holding the funding at more than it needs to replace it
   * (CKB's min_replace_fee), so the funding never confirms. The LSP then ends the channel (fnn's
   * FundingInputSpent, 2026-11-10) and refreshChannel says it never funded. Returns the hash sent.
   * Before it, such an opening held one of the wallet's channels at the LSP for as long as its coins
   * stayed where they were. */
  async cancelOpening(wallet: ccc.Signer): Promise<string> {
    if (!this.channelId) throw new Error('No opening here to give up.')
    if (this.state.channel?.ready || this.state.channel?.closed) throw new Error('This channel is not an opening any more: close it instead.')
    const kept = await this.read<ChannelInfo>(CHANNEL_INFO, {})
    if (kept.channel_id !== this.channelId || !kept.funding || !kept.inputs?.length) throw new Error('The wallet signed no funding for this opening, so nothing of it waits.')
    const call = async (method: string, params: unknown[]) => JSON.parse(await this.ckbCall(method, JSON.stringify(params))).result
    const hash = await giveUpFunding(wallet, kept.funding, kept.inputs, call)
    this.log(`Gave up the opening: a coin its funding spends went back to the wallet (${hash.slice(0, 12)}…); the funding can no longer confirm.`)
    return hash
  }

  async askClose(): Promise<void> {
    if (!this.token) throw new Error('No channel here to close.')
    const r = await this.post(`${this.config.gateway}/close-stuck`, '{}', this.token)
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? `The LSP did not close it (${r.status}).`)
    this.log('Asked the LSP to close this channel by force.')
    // Closing from here on, and no longer stuck: what remains is the LSP's close (refreshChannel).
    this.forcing = true
    this.set({ closing: true, stuck: null })
    this.say(FORCING_SAYS)
    this.lastChannel = 0
    this.wakeUp?.()
  }

  /** Something moved: the loop goes fast for `ms`, from now. */
  private stir(ms = BUSY_MS) {
    this.busyUntil = Math.max(this.busyUntil, Date.now() + ms)
    this.wakeUp?.()
  }

  /** Waits at the gateway for this tenant's next change at the LSP (a signature asked, a payment in
   * or out), and runs the loop's next round at once when it comes: on the rounds' clock alone, 4.5 s
   * of a 6 s payment were waits (dev chain, 2026-10-30). A gateway that does not hear the LSP's
   * changes says so and is asked again in a minute; one without /wait is not asked again. */
  private async watch() {
    if (this.watching) return
    this.watching = true
    try {
      while (this.running) {
        if (this.away) {
          await sleep(1000)
          continue
        }
        let said: { seq?: number; live?: boolean; asks?: { id: string; amount: string }[] }
        try {
          const r = await this.post(`${this.config.gateway}/wait`, JSON.stringify({ since: this.seen }), this.token)
          if (r.status === 404) return
          said = await r.json()
        } catch {
          await sleep(5000)
          continue
        }
        this.hearing = !!said.live && typeof said.seq === 'number'
        if (said.asks?.length) void this.answerAsks(said.asks)
        if (!this.hearing) {
          // A payer may be waiting for an invoice made here (said.asks spoken at all): soon, not in a minute.
          await sleep(Array.isArray(said.asks) && this.state.link ? 3000 : 60_000)
          continue
        }
        if (said.seq !== this.seen) {
          this.seen = said.seq!
          // A request its signer refuses changes the tenant again and again: followed on the
          // stuck clock, not at once (nextTick).
          if (this.calm()) {
            await sleep(STUCK_TICK_MS)
            continue
          }
          this.woken = true
          this.wakeUp?.()
          // Asked again once that round is over: what its own signatures changed meanwhile comes
          // back as one answer, not one each (72 waits a payment otherwise, 2026-10-30).
          await Promise.race([new Promise<void>((r) => this.afterRound.push(r)), sleep(5000)])
        }
      }
    } finally {
      this.watching = false
      this.hearing = false
    }
  }

  private nap(ms: number): Promise<void> {
    // A change heard while the last round ran: this round now, at the next task. Not at once, and not
    // while away: no round runs away to clear what was heard, and a nap that ended at once turned the
    // loop round and round in one task, the page frozen and white (a tester's phone, 2026-10-30 and 31: the
    // stack in this loop, test/away-spin.test.ts). Away, it waits for its clock, or a stir on return.
    if (this.woken && !this.away) return new Promise((done) => setTimeout(done, 0))
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.wakeUp = null
        done()
      }, ms)
      this.wakeUp = () => {
        clearTimeout(timer)
        this.wakeUp = null
        done()
      }
    })
  }

  /** Be let in by the gateway: true once it is, false where it never will be here. One at a
   * time (`joining`), so a rejoin while waiting does not start a second loop. */
  private async join(): Promise<boolean> {
    for (;;) {
      if (this.leaving) return false
      const greeted = await this.hello()
      if (this.leaving) return false
      if (this.state.unanswered !== !!greeted.unanswered) this.set({ unanswered: !!greeted.unanswered })
      if ((greeted.ok || greeted.stale) && (await this.store.get(BACK)) === this.tenantId && (await this.afterBack(greeted))) return false
      if (greeted.ok) return true
      if (greeted.stale) {
        await this.catchUp()
        return false
      }
      // The gateway or the LSP did not answer, as while either restarts: ask again. Giving up
      // here stopped every beat for good on a server, whose presence never comes back by itself
      // (the demo shop on 2026-10-12, away from LSP2's restart at 15:21 until restarted itself).
      if (greeted.unanswered) {
        await sleep(5000)
        continue
      }
      if (!greeted.elsewhere) return false
      this.say('Your channel is open on another device. This page takes over a few seconds after you close it there.')
      await sleep(5000)
    }
  }

  private rejoin() {
    this.running = false
    void this.run()
  }

  /** Another device signed since this host last did: take the newer state from the backup
   * before signing anything. With the key already here no passkey is needed. */
  private async catchUp() {
    const keeper = this.host.keeper
    if (!keeper || !this.backupKey || !this.access) {
      this.set({ behind: true, status: 'Your channel moved on in another browser. Bring it up to date here with your passkey.' })
      return
    }
    try {
      const r = await fetch(`${this.config.gateway}/backup/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant_id: this.tenantId, access: this.access }) })
      const saved = await r.json()
      if (!r.ok) throw new Error(saved.error)
      // Never an older copy over the one here: the gateway said a newer one exists.
      if (!(saved.version > (await this.backupVersion()))) throw new Error('the gateway handed back a copy no newer than the one here')
      await this.takeBackup(await keeper.open(this.backupKey, this.tenantId, saved.version, saved))
      await this.setBackupVersion(saved.version)
      this.host.restart()
    } catch (e) {
      this.log(`Could not catch up with the key here: ${message(e)}`)
      this.set({ behind: true, status: 'Your channel moved on in another browser. Bring it up to date here with your passkey.' })
    }
  }

  /** A channel brought back from aside (bringBack), at the gateway's first answer. The key kept here
   * backs it up only once it opens this channel's backup. Behind the backup's count, the copy here
   * is older than the backup, and an older copy cannot sign its own share after a close by force
   * (dev chain, 2026-11-20): so it goes on as it is only when it holds the same state as the
   * backup, and otherwise takes the backup, the newest copy. Behind a count of its own that is a
   * catch-up; with none (set aside before the count went with it) the backup is brought, as restore
   * brings one (only taken out, together with the LSP). With no key here to open the backup, nothing
   * runs on the older copy: the passkey is asked (catchUp). True when the host starts again for it. */
  private async afterBack(greeted: { stale?: boolean; version?: number }): Promise<boolean> {
    const keeper = this.host.keeper
    let opened: string | undefined
    let version: number | undefined
    try {
      const kept = keeper ? await keeper.stored() : {}
      if (keeper && kept.key && kept.access) {
        const r = await fetch(`${this.config.gateway}/backup/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant_id: this.tenantId, access: kept.access }) })
        const saved = await r.json()
        if (r.ok) {
          opened = await keeper.open(kept.key, this.tenantId, saved.version, saved)
          version = saved.version
          this.backupKey = kept.key
          this.access = kept.access
          this.set({ kept: true, rekeep: false })
        }
      }
    } catch (e) {
      this.log(`The key kept here does not open this channel's backup: ${message(e)}`)
    }
    await this.store.remove(BACK)
    if (!greeted.stale) return false
    // Nothing newer to take: the older copy here is not started (catchUp asks for the passkey).
    if (opened === undefined || version === undefined) return false
    const count = await this.backupVersion()
    // Never an older copy over the one here (plan A3).
    if (!(version > count)) return false
    if (unpackBackup(opened).state !== (await this.store.get(STATE, SEALED))) {
      await this.takeBackup(opened)
      if (!count) {
        await this.store.set(RETIRE, this.tenantId)
        await this.store.set(BROUGHT, this.tenantId)
        this.log('Brought back from aside behind its backup: its backup, the newest copy, is taken, and it is only closed together with the LSP.')
      } else this.log('Brought back from aside behind its backup: its backup, the newest copy, is taken.')
    }
    await this.setBackupVersion(version)
    this.host.restart()
    return true
  }

  /** A channel the LSP closes for being unused (hello's `idle_close_at`): from shortly before that
   * date, the close the LSP asks is approved here. Fiber has the side that asks a close pay all of
   * its fee, at the channel's rate (the gateway asks at LSP_CLOSE_FEE_RATE), so this side pays
   * nothing, and the signer only signs a close that pays this side to the lock the channel was
   * opened with. No passkey: nothing leaves for anywhere but that wallet. Without it the close
   * waits for a signature until the LSP forces it, and the share then waits for this host. */
  private async approveIdleClose() {
    const at = this.state.idleCloseAt
    const c = this.state.channel
    // At the rate the gateway fixed for this close, which it asks the LSP at too (the pool's, when it
    // fixed it), within the signer's bound; approved again if it says another.
    const said = this.idleCloseFeeRate ?? LSP_CLOSE_FEE_RATE
    const rate = Math.min(Math.max(said, LSP_CLOSE_FEE_RATE), Number(CLOSE_FEE_RATE_MOST))
    const approval = `${this.channelId}:${rate}`
    if (!at || !this.channelId || this.idleApproved === approval || this.state.closing || !c || c.closed || Date.now() < at - IDLE_APPROVE_EARLY_MS) return
    const local = JSON.parse(await this.signer!.openingRequest()).shutdown_script
    const kept = await this.read<{ channel_id?: string; remote_shutdown_script?: unknown }>(CHANNEL_INFO, {})
    const remote = kept.channel_id === this.channelId && kept.remote_shutdown_script ? kept.remote_shutdown_script : this.config.lspShutdown
    await this.signer!.authorizeClose(this.channelId, JSON.stringify(local), JSON.stringify(remote), 0, rate)
    this.idleApproved = approval
    this.log('The LSP closes this unused channel at its date: approved here, at no fee to you.')
  }

  private async tick() {
    // Woken by a change at the LSP (watch): the channel, then the invoices, read now and not on
    // their clocks, the channel first so that a payment coming in is known to this round.
    const woken = this.woken
    this.woken = false
    try {
      await this.approveIdleClose().catch((e) => this.log(`Unused channel's close: ${message(e)}`))
      // The signing below goes on whatever the sent list's reading meets.
      await this.resolveSent().catch((e) => this.log(`Sent payments: ${message(e)}`))
      // A payment takes several signatures in a row; sign each as soon as it is asked for.
      let signed = false
      let refused = false
      for (let round = 0; round < 8; round++) {
        const done = JSON.parse(await this.signer!.poll())
        signed ||= !!done.signed
        if (done.signed || done.watchtower) {
          this.log(`Signed ${done.signed} channel update(s) and ${done.watchtower} settlement(s).`)
          this.stir()
        }
        if (done.signed && this.state.closing) this.lastChannel = 0
        for (const w of done.warnings ?? []) {
          this.log(`Warning from the signer: ${w}`)
          refused ||= /^channel request not signed/.test(w)
        }
        if (!done.signed && !done.watchtower) break
      }
      this.refusing(refused && !signed)
      // Each update the LSP signed revoked a commitment of its own: one more record to watch.
      if (signed) await this.passToWatcher()
      // A page that said bye during this round asks nothing more: a call after the bye woke its
      // tenant at the LSP, which then sent a payment to a signer that was gone (nightly, 2026-10-27).
      if (this.away || !this.running) return
      if (woken) await this.refreshChannel(true)
      await this.settleInvoices(woken)
      await this.refreshChannel()
      await this.refreshLink()
    } catch (e) {
      this.log(`Signer: ${message(e)}`)
      if (/open on another device/.test(message(e))) this.rejoin()
    } finally {
      for (const done of this.afterRound.splice(0)) done()
    }
  }

  private async refreshChannel(now = false) {
    if (!this.channelId || (!now && Date.now() - this.lastChannel < Math.min(3000, this.config.loopFloorMs ?? 3000))) return
    this.lastChannel = Date.now()
    const { channels } = await this.lsp<{ channels: RawChannel[] }>('list_channels', { include_closed: true })
    const c = channels.find((x) => x.channel_id === this.channelId)
    // What the LSP's lists said of it, kept: its funding cell, and that it was funded. One listed
    // funded once is not said never funded on an answer without it, which only says nothing ("Top up again" could
    // otherwise set aside a channel still open).
    const kept = await this.read<ChannelInfo>(CHANNEL_INFO, {})
    const ours = !kept.channel_id || kept.channel_id === this.channelId
    const fundedNow = !!c && c.state.state_name !== 'NegotiatingFunding'
    if (c && ours && ((c.channel_outpoint && c.channel_outpoint !== kept.outpoint) || (fundedNow && !kept.funded)))
      await this.store.set(CHANNEL_INFO, JSON.stringify({ ...kept, channel_id: this.channelId, outpoint: c.channel_outpoint ?? kept.outpoint, funded: !!kept.funded || fundedNow }))
    // Funded once and no longer listed is a channel still open, unless its funding never reached
    // the chain and never can.
    // Listed and still waiting for its funding, which never can land, is the same: the LSP kept a
    // signed external funding while it might still confirm, even with the wallet's coin spent
    // elsewhere (AwaitingChannelReady for good, dev chain, 2026-11-10), and its wallet waited too.
    const waiting = !!c && ours && !this.state.opening && FUNDING_WAIT.has(c.state.state_name)
    const lostListed = waiting && !!kept.funded && (!!kept.stranded || (await this.fundingNeverLands(kept)))
    const lost = (!c && ours && !!kept.funded && !this.state.opening && (!!kept.stranded || (await this.fundingNeverLands(kept)))) || lostListed
    const unfunded = (neverFunded(c, this.state.opening) && !(!c && ours && kept.funded && !lost)) || lostListed
    if (unfunded !== this.state.unfunded) this.set({ unfunded })
    if (unfunded) {
      // Not a channel to pay from or wait for: no channel, and the way out is to start over.
      if (this.state.channel) this.set({ channel: null })
      this.say(
        lost
          ? "Your last channel's opening did not reach the chain: a coin it spent was spent first by another transaction, and nothing left your wallet."
          : "Your last channel's opening did not finish: your wallet did not sign it, and nothing left it.",
      )
      return
    }
    if (!c) return
    // A channel the LSP still says is closing may be closed on chain already (closedOnChain).
    const onChain = c.state.state_name === 'ShuttingDown' ? await this.closedOnChain(c) : null
    const flags = c.state.state_flags ?? ''
    const { going, receiving } = inFlight(c.pending_tlcs ?? [])
    this.incoming = comingIn(c.pending_tlcs ?? [])
    // Paid here: out of the balance now, the opening fee too (feePaid).
    const paidHere = (await this.sentList()).filter((p) => p.channel_id === c.channel_id && p.status === 'Paid')
    const paid = new Set(paidHere.map((p) => p.payment_hash.toLowerCase()))
    const channel: FiberChannel = {
      id: c.channel_id,
      ready: c.state.state_name === 'ChannelReady',
      closed: c.state.state_name === 'Closed' || !!onChain,
      unsettled: (c.state.state_name === 'Closed' && /WAITING_ONCHAIN_SETTLEMENT/.test(flags)) || (!!onChain && !onChain.settled),
      // Closed on chain while closing: by force when a commitment closed it, or when something is
      // left to claim (a cooperative close pays straight out), as the chain says (closedOnChain).
      forced: /UNCOOPERATIVE/.test(flags) || (!!onChain && onChain.forced),
      stateName: onChain ? 'Closed' : c.state.state_name,
      local: BigInt(c.local_balance) - paidOut(c.pending_tlcs ?? [], paid),
      remote: BigInt(c.remote_balance),
      going,
      // Only payments coming in: a payment going out may wait at the LSP for its payee.
      receiving,
      feePaid: paidHere.some((p) => p.what === 'fee'),
      outpoint: c.channel_outpoint ?? null,
      token: c.funding_udt_type_script ?? null,
      unit: null,
      reserve: c.funding_udt_type_script
        ? ours && kept.reserve ? BigInt(kept.reserve) : null
        : ours && kept.ckb_reserve ? BigInt(kept.ckb_reserve) : LEGACY_RESERVE,
    }
    // A channel of a token is recorded once, so its payments keep saying their token after it closes;
    // one opened elsewhere, with what the gateway says of it now.
    if (channel.token) {
      let mine = (await this.tokensKept())[channel.id]
      if (!mine) mine = await this.keepToken(channel.id, { name: '', script: channel.token, decimals: 8, cellDep: null, linkMost: LINK_MOST })
      // Asked of the gateway once, apart: its terms may wait a minute, and a refresh must not.
      if (!mine.name && !this.tokenAsked.has(channel.id)) {
        this.tokenAsked.add(channel.id)
        void this.learnToken(channel.id, channel.token)
      }
      channel.unit = { name: mine.name, decimals: mine.decimals }
    }
    const was = this.state.channel
    if (channel.closed) {
      this.set({ closing: false })
      this.forcing = false
    }
    this.set({ channel })
    if (channel.receiving !== was?.receiving) await this.holdScreen()
    if (channel.ready && !this.state.closing) this.say('Your channel is ready. Close the app whenever you like; payments wait for you.')
    else if (channel.unsettled) this.say('Closed by force. Your share comes back to your wallet when this app signs it, once the chain allows: open it from time to time.')
    else if (channel.closed) this.say(channel.forced ? 'Closed by force. Your share is back in your wallet.' : 'Closed. What was yours went back to your wallet.')
    else if (this.forcing) this.say(FORCING_SAYS)
    else if (this.state.closing && closeNoLongerNeedsPage(channel.stateName, flags)) this.say('Closing signed. It reaches your wallet in about a minute, with the app open or not.')
    else if (this.state.closing) this.say(`Closing (${channel.stateName}). Keep the app open until it says closed.`)
    else if (pageNoLongerNeeded(channel.stateName)) this.say('Channel funded. It is ready in about a minute, with the app open or not.')
    else this.say(`Channel ${channel.stateName}. It is ready in about a minute; keep the app open.`)
  }

  /** Whether a channel the LSP says is still closing (ShuttingDown) was closed on chain: its funding
   * cell is spent, the transaction that made it being committed (a spent cell reads "unknown", as
   * one never made does). Closed by another commitment than the one it waits for, the tenant's side
   * at the LSP waits for good while the LSP's own side says Closed (a tester's phone, 2026-10-14: a
   * quick balance of 1,000 CKB shown long after it was paid out, and counted twice on Home).
   * `settled`: nothing of this side is left to claim from it (recovery). `forced`: what spent the
   * funding cell was a commitment (this side's, or the LSP's current one) or a revoked one, not the
   * closing both signed; not known, by force, the side that asks for the app again. Asked at most
   * once a minute; null while the funding cell is live or the chain cannot say. */
  private async closedOnChain(c: RawChannel): Promise<{ settled: boolean; forced: boolean } | null> {
    const op = c.channel_outpoint
    if (!op || !/^0x[0-9a-fA-F]{72}$/.test(op)) return null
    const kept = this.chainSaid.get(op)
    if (kept && (kept.settled || Date.now() - kept.at < 60_000)) return kept.spent ? { settled: kept.settled, forced: kept.forced } : null
    try {
      const txHash = op.slice(0, 66)
      const index = '0x' + BigInt('0x' + op.slice(66).match(/../g)!.reverse().join('')).toString(16)
      const live = JSON.parse(await this.ckbCall('get_live_cell', JSON.stringify([{ tx_hash: txHash, index }, false]))).result?.status
      let spent = false
      if (live !== 'live') spent = JSON.parse(await this.ckbCall('get_transaction', JSON.stringify([txHash]))).result?.tx_status?.status === 'committed'
      let settled = false
      let forced = true
      // Closed either way; what closed it, and whether anything is left to claim, is the recovery's
      // to say. The LSP's flags cannot say it: a V2 cooperative close waits as
      // WAITING_COMMITMENT_CONFIRMATION too (fnn's channel_v2.rs), and read as forced.
      if (spent) {
        const said = await this.recoveryFor(false)
          .then((r) => r.status())
          .catch(() => null)
        settled = said?.next.kind === 'done'
        forced = !said || said.published || said.closedByPeer || said.next.kind !== 'done'
      }
      this.chainSaid.set(op, { at: Date.now(), spent, settled, forced })
      if (spent && !kept?.spent) this.log(`The LSP still says closing, but the channel's funding cell is spent: closed on chain${forced ? ' by force' : ''}${settled ? ', and nothing is left to claim' : ''}.`)
      return spent ? { settled, forced } : null
    } catch (e) {
      this.log(`Chain check of a closing channel: ${message(e)}`)
      return kept?.spent ? { settled: kept.settled, forced: kept.forced } : null
    }
  }

  /** Whether the funding of the channel kept here can never reach the chain (opening.ts,
   * fundingStranded), for a channel the LSP no longer lists or lists still waiting for its funding
   * (FUNDING_WAIT). Asked at most once a minute, and said
   * only once the chain has said so twice a minute apart: the next node asked, when one fails, may be
   * a block behind the first. Kept once said (`stranded`). */
  private async fundingNeverLands(kept: ChannelInfo): Promise<boolean> {
    const funding = kept.outpoint && /^0x[0-9a-fA-F]{72}$/.test(kept.outpoint) ? kept.outpoint.slice(0, 66) : kept.funding
    const at = Date.now()
    if (!funding || at - this.landAsked < 60_000) return false
    this.landAsked = at
    const call = async (method: string, params: unknown[]) => JSON.parse(await this.ckbCall(method, JSON.stringify(params))).result
    const never = await fundingStranded(funding, kept.inputs ?? [], call)
    if (never !== true) {
      if (never === false) this.landLost = null
      return false
    }
    if (this.landLost?.funding !== funding) this.landLost = { funding, since: at }
    if (at - this.landLost.since < 60_000) return false
    await this.store.set(CHANNEL_INFO, JSON.stringify({ ...kept, stranded: true }))
    this.log(`The channel's funding ${funding.slice(0, 12)}… never reaches the chain: a cell it spends was spent by another transaction, and the LSP no longer lists the channel.`)
    return true
  }

  /** Whether a channel set aside under `aside`, which its tenant's list still says is closing, is over
   * on chain: its funding cell spent, the transaction that made it committed, and nothing of this
   * side left to claim, as its own signer's recovery says (closedOnChain's rule). False while the
   * funding cell is live, something is left (its rounds sign the settlement), or the chain cannot say. */
  private async asideSettledOnChain(c: RawChannel, signer: LspSigner, aside: string): Promise<boolean> {
    const op = c.channel_outpoint
    if (!op || !/^0x[0-9a-fA-F]{72}$/.test(op)) return false
    try {
      const txHash = op.slice(0, 66)
      const index = '0x' + BigInt('0x' + op.slice(66).match(/../g)!.reverse().join('')).toString(16)
      const live = JSON.parse(await this.ckbCall('get_live_cell', JSON.stringify([{ tx_hash: txHash, index }, false]))).result?.status
      if (live === 'live') return false
      if (JSON.parse(await this.ckbCall('get_transaction', JSON.stringify([txHash]))).result?.tx_status?.status !== 'committed') return false
      const said = await recoveryOf(signer, (method, params) => this.ckbCall(method, params), () => this.keptPreimages(aside)).then((r) => r.status())
      return said.next.kind === 'done'
    } catch (e) {
      this.log(`Chain check of an old channel: ${message(e)}`)
      return false
    }
  }

  /** While payments arrive, keep the screen on where the host allows it. */
  private holdScreen() {
    return this.host.presence.holdScreen(!!this.state.channel?.receiving)
  }

  /** Resolves once this host's channel is ready to pay. */
  whenReady(): Promise<void> {
    if (this.state.channel?.ready) return Promise.resolve()
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        if (this.state.channel?.ready) {
          off()
          resolve()
        }
      })
    })
  }

  /** If the channel is ever closed by force, let the signer settle this side to the lock the
   * channel was opened with, and nowhere else, within a fee cap. */
  private async protect() {
    if (!this.channelId) return
    try {
      const local = JSON.parse(await this.signer!.openingRequest()).shutdown_script
      await this.signer!.authorizeWatchtower(this.channelId, JSON.stringify(local), SETTLE_MAX_FEE)
      this.log('If the channel is ever closed by force, the signer settles your side to your wallet, and only there.')
    } catch (e) {
      this.log(`Settlement approval: ${message(e)}`)
    }
  }

  /** Open a channel funded by the wallet: `spend` CKB to pay with (whole, within config.spend)
   * and the reserve. The passkey comes first, while the tap still counts as the person's own
   * gesture.
   *
   * `beforeSign`, when given, is awaited before the wallet is asked to sign the funding, and
   * again after a signature that failed (with its reason): a page uses it to wait for a tap of
   * the person's own, because a wallet that signs in a popup (JoyID) is blocked by the browser
   * when the popup opens long after the tap that started the opening (the passkey and the LSP
   * take that long). Rejecting it gives up; the opening is then never funded (`unfunded`).
   *
   * `beforeOpen`, when given, is awaited once no channel set aside here is still open, before the LSP
   * is asked for anything: an app checks there what the session cannot see, as a balance of the same
   * wallet open on another device, and rejects to give up. */
  /** Open a channel funded from `wallet`: `spend` CKB, or with `opts.token`, `amount` of that token
   * (in its smallest unit), the wallet putting in only the CKB the LSP's opening fee and the token
   * cell need. Token channels are a trial on a test LSP for now. */
  async open(
    wallet: ccc.Signer,
    spend: bigint = this.config.spend.default,
    opts: { beforeSign?: (failed?: string) => Promise<void>; beforeOpen?: () => Promise<void>; token?: { script: ccc.ScriptLike; amount: bigint } } = {},
  ) {
    const { min, max } = this.config.spend
    const token = opts.token ? { script: ccc.Script.from(opts.token.script), amount: opts.token.amount } : undefined
    if (token ? token.amount <= 0n : spend < min || spend > max) throw new Error(token ? 'a token channel needs some of the token' : `a channel spends from ${min} to ${max} CKB`)
    // The LSP's fee for an opening from this wallet, once per wallet, goes in on top of
    // what the channel spends; the channel pays it first, once ready (payOpeningFee).
    const terms = await lspTerms(this.config.gateway, walletKey((await wallet.getRecommendedAddressObj()).script))
    const cap = terms.walletCap
    if (cap) throw new Error(cap.code === 'wallet_cap' ? WALLET_CAP(cap.open ?? cap.most) : WALLET_CAP_UNKNOWN)
    // A token channel: the LSP must open one of that token, with room of its own and its fee priced;
    // the fee goes on top of what it spends, in the token, as a CKB channel's does in CKB.
    const tokenTerms = token ? terms.tokens.find((t) => sameScript(t.script, toFiberScript(token.script))) : undefined
    if (token && !tokenTerms) throw new Error('this LSP opens no Fiber balance of that token')
    if (tokenTerms && tokenTerms.openingFee === null) throw new Error(`the opening fee in ${tokenTerms.name} cannot be priced just now; try again in a while`)
    const tokenFee = tokenTerms?.openingFee ?? 0n
    // The fee is what the gateway says, and the person agreed to an amount: past the most accepted
    // here, nothing is spent (a gateway that lies would otherwise take what the wallet holds).
    const feeMost = this.config.openingFeeMost ?? FEE_MOST
    if (!token && terms.openingFee > feeMost) throw new Error(`the LSP asks ${ckb(terms.openingFee)} CKB to open a channel, more than the ${ckb(feeMost)} CKB accepted here, so nothing was spent`)
    if (!(tokenTerms ? tokenTerms.canOpen : terms.canOpen)) throw new Error(NO_ROOM)
    await this.start()
    if (tokenTerms) await this.tellTokens([tokenTerms])
    if (this.bringing) throw new Error(ASIDE_BACK)
    if (this.state.phase !== 'running') throw new Error(this.state.status || 'the signer is not running')
    if (this.channelId && !this.state.channel?.closed) throw new Error('this browser already has a channel')
    // A channel set aside here that is still open is the channel to use: never a second beside it
    // (it comes back by itself, backAside).
    await this.asideFirst
    if (this.asideOpen.size) throw new Error(ASIDE_BACK)
    await opts.beforeOpen?.()
    // Room rented from the channel before: the LSP funds it for this one once the rent is here.
    await this.carryRents()
    this.set({ opening: true })
    let sent = false
    // The channel's backup key, from the keeper's passkey; with nothing to keep it, the channel lives
    // in this host only.
    const keepIt = async () => {
      if (this.backupKey || !this.host.keeper) return
      try {
        const made = await this.host.keeper.create(this.tenantId)
        this.backupKey = made.key
        this.access = made.access
      } catch (e) {
        this.log(`No passkey, so this channel lives in this browser only: ${message(e)}`)
      }
    }
    try {
      if (!this.host.keeper?.afterSign) await keepIt()
      await this.store.set(OWNER, this.config.ownerKey((await wallet.getRecommendedAddressObj()).script.hash()))
      const material = JSON.parse(await this.signer!.status()).channel_open_signer_material
      if (!material) throw new Error('no channel key is ready; reload the app')
      const { lock, cellDeps } = await fundingLock(wallet)
      // The change must come back as a cell of its own, or the LSP cannot build the funding and holds
      // the coins until it drops the opening (opening.ts, fundingShort). Unread, the LSP decides.
      const put = fundingPut(spend, terms.openingFee, this.config.reserveCkb)
      const keep = ccc.CellOutput.from({ capacity: 0n, lock }).occupiedSize
      const free = await wallet.client.getBalance([lock]).catch(() => null)
      // A token channel's CKB is what fnn reserves for its cell, which the LSP's builder takes from
      // the wallet: short, it says so before anything is signed.
      if (!token && free !== null && fundingShort(free, put * 100_000_000n, keep) > 0n) throw new Error(NO_CHANGE(ckb(free), put, keep))
      const feeRate = await fundingFeeRate(wallet)
      const params = {
        pubkey: this.config.lspPubkey,
        public: false,
        funding_amount: hex(token ? token.amount + tokenFee : put * 100_000_000n),
        ...(token ? { funding_udt_type_script: toFiberScript(token.script) } : {}),
        commitment_fee_rate: '0x3e8',
        commitment_delay_epoch: this.delay.field,
        ...(this.delay.tlcExpiryDelta ? { tlc_expiry_delta: this.delay.tlcExpiryDelta } : {}),
        shutdown_script: toFiberScript(lock),
        funding_lock_script: toFiberScript(lock),
        funding_lock_script_cell_deps: cellDeps,
        external_channel_signer: material,
        // What the pool asks now, more for a witness larger than the one Fiber prices for: left
        // out, the LSP builds at the least rate, and in a full pool the funding waits for hours.
        funding_fee_rate: feeRate,
      }
      this.say('Asking the LSP for the channel…')
      let opened: { channel_id: string; unsigned_funding_tx: FiberTransaction; opening_context?: { remote_shutdown_script?: unknown; local_reserved_ckb_amount?: string } } | undefined
      // The same request again returns the same opening, if the first answer was lost. An
      // opening the LSP stopped is not asked again: its side was not funded (seen 2026-10-03,
      // when its wallet could not cover the 160 CKB it puts in), and nothing left the wallet.
      const places: { at: number; ahead: number }[] = []
      for (let attempt = 1; !opened; ) {
        try {
          opened = JSON.parse(await this.signer!.openChannel(JSON.stringify(params)))
        } catch (e) {
          // Waiting its turn is not a try: asked again every few seconds, the place said, and once
          // it has moved, about how long is left (opening.ts, turnWait).
          const turn = BUSY.exec(message(e))
          if (turn) {
            const ahead = Number(turn[1])
            if (places[places.length - 1]?.ahead !== ahead) places.push({ at: Date.now(), ahead })
            const wait = turnWait(places, Date.now())
            if (!wait.stalled) {
              this.say(`Waiting for your turn: ${ahead} ahead of you${wait.minutes ? `, about ${wait.minutes} min` : ''}.`)
              await sleep(5000)
              continue
            }
          }
          this.log(`Opening, try ${attempt}: ${message(e)}`)
          const verdict = openingFailure(message(e), attempt, !!turn)
          if (verdict !== 'retry') {
            this.say('')
            if (verdict === 'no-room') throw new Error(NO_ROOM)
            if (verdict === 'busy') throw new Error(BUSY_SAID)
            // Refused by the gateway before the LSP built anything (WALLET_CAP): the wallet's count
            // changed since the terms were read, or they could not be.
            const open = walletCapOpen(message(e))
            if (verdict === 'wallet-cap' && open !== null) throw new Error(WALLET_CAP(open))
            if (verdict === 'wallet-cap-unknown') throw new Error(WALLET_CAP_UNKNOWN)
            if (verdict === 'not-built') throw new Error(NOT_BUILT(put))
            throw e
          }
          attempt++
          await sleep(3000)
        }
      }
      this.channelId = opened!.channel_id
      this.set({ channelId: this.channelId })
      if (tokenTerms) await this.keepToken(this.channelId, tokenTerms)
      // What the channel sets aside on the wallet's side, as the LSP's terms say it: `reserve` for a
      // token (its presence says a token, publish), `ckb_reserve` for CKB.
      const setAside = opened!.opening_context?.local_reserved_ckb_amount
      const reserve = token ? setAside : undefined
      const ckb_reserve = token ? undefined : setAside
      await this.store.set(CHANNEL_INFO, JSON.stringify({ channel_id: this.channelId, remote_shutdown_script: opened!.opening_context?.remote_shutdown_script, ...(reserve ? { reserve } : {}), ...(ckb_reserve ? { ckb_reserve } : {}) }))
      this.say('The LSP built the channel and the signer checked it. Sign it in your wallet.')
      let signed: Awaited<ReturnType<typeof signFunding>> | undefined
      for (let failed: string | undefined; !signed; ) {
        await opts.beforeSign?.(failed)
        try {
          signed = await signFunding(opened!.unsigned_funding_tx, wallet, token?.script)
        } catch (e) {
          this.log(`The wallet did not sign the channel: ${message(e)}`)
          if (!opts.beforeSign) throw e
          failed = message(e)
        }
      }
      // What the signed funding spends, kept, so a funding that never reaches the chain is told
      // (fundingNeverLands); its signatures leave its hash as it was.
      const unsigned = opened!.unsigned_funding_tx
      const info = await this.read<ChannelInfo>(CHANNEL_INFO, {})
      await this.store.set(CHANNEL_INFO, JSON.stringify({ ...info, funding: fiberTxHash(unsigned), inputs: unsigned.inputs.map((i) => i.previous_output) }))
      if (this.host.keeper?.afterSign && !this.backupKey) {
        await keepIt()
        await this.backUp((await this.store.get(STATE, SEALED)) ?? '').catch((e) => this.log(`The first backup was not kept: ${message(e)}`))
      }
      await submitFunding(
        () => this.lsp('submit_signed_funding_tx', { channel_id: this.channelId, signed_funding_tx: signed }),
        () => this.wakeUp?.(),
      )
      // The gateway now asks the fee once; hello says it again on the next start.
      const fee = token ? tokenFee : terms.openingFee
      await this.store.set(FEE_AGREED, JSON.stringify({ channel: this.channelId, fee: fee.toString() }))
      if (fee > 0n) this.set({ feeDue: fee })
      this.say('Signed and sent. The channel is ready in about a minute.')
      await this.protect()
      await this.refreshChannel(true).catch(() => {})
      sent = true
    } finally {
      this.set({ opening: false })
      // An opening the LSP built and this page gave up before the wallet signed it is read again at
      // once, and said never funded: until the next round the page said "Getting ready" and offered
      // to take it out on chain.
      if (!sent && this.channelId) void this.refreshChannel(true).catch(() => {})
    }
  }

  /** Close cooperatively: everything on this side goes back to the lock the channel was opened
   * with. The signer only signs a close that pays that lock, at the fee approved here. */
  async close() {
    if (!this.channelId || !this.state.channel?.ready) throw new Error('no open channel to close')
    // A payment just made is still being signed off: a close now would wait for it for good.
    await waitSettled(async () => {
      await this.refreshChannel(true)
      return this.state.channel
    })
    await this.stepUp()
    const local = JSON.parse(await this.signer!.openingRequest()).shutdown_script
    const kept = await this.read<{ channel_id?: string; remote_shutdown_script?: unknown }>(CHANNEL_INFO, {})
    const remote = kept.channel_id === this.channelId && kept.remote_shutdown_script ? kept.remote_shutdown_script : this.config.lspShutdown
    this.set({ closing: true })
    this.stir()
    this.say('Closing. Keep the app open until it says closed.')
    // We pay the close at the rate the pool asks (closeFeeRateBy, 1,000 when it is quiet); the LSP
    // accepts and pays nothing. At 1,000 alone a close waits in a full pool for as long as it is.
    const rate = await closeFeeRateBy((method, params) => this.ckbCall(method, JSON.stringify(params)).then((r) => JSON.parse(r).result))
    await this.signer!.authorizeClose(this.channelId, JSON.stringify(local), JSON.stringify(remote), Number(rate), 0)
    await this.lsp('shutdown_channel', { channel_id: this.channelId, close_script: local, fee_rate: hex(rate), force: false })
  }

  /** A tenant opens one channel, with its signer's one-time key material, so a new channel
   * after a close is a new tenant: this one's saved state is set aside under its id, so it can
   * still sign a settlement after a force close, and the host starts again. Only a channel known
   * not to be open: closed, or never funded, as the LSP says just now and its funding cell on chain
   * says too; one not read is not set aside. A channel set aside
   * here that is still open comes back instead (bringBack). */
  async startOver() {
    if (this.channelId) {
      // Closed is for good: read again only one that is not, as a top-up never funded.
      if (!this.state.channel?.closed)
        try {
          await this.refreshChannel(true)
        } catch {
          throw new Error(NOT_READ)
        }
      const c = this.state.channel
      if (!this.state.unfunded && !c?.closed) throw new Error(c ? STILL_OPEN : NOT_READ)
      const kept = await this.read<ChannelInfo>(CHANNEL_INFO, {})
      const outpoint = c?.outpoint ?? (kept.channel_id === this.channelId ? kept.outpoint : undefined)
      const live = outpoint ? await this.fundingLive(outpoint) : false
      if (live !== false) throw new Error(live ? STILL_OPEN : NOT_READ)
    }
    await this.asideFirst
    const open = [...this.asideOpen][0]
    if (open) return this.bringBack(open[0], open[1])
    await this.setAside(this.tenantId.slice(0, 8))
    await this.setBackupVersion(0)
    await this.store.remove(RETIRE)
    await this.store.remove(BROUGHT)
    this.running = false
    this.bye()
    this.host.restart()
  }

  /** Whether a funding cell is live on chain; null when the chain cannot say. */
  private async fundingLive(outpoint: string): Promise<boolean | null> {
    if (!/^0x[0-9a-fA-F]{72}$/.test(outpoint)) return null
    try {
      const index = '0x' + BigInt('0x' + outpoint.slice(66).match(/../g)!.reverse().join('')).toString(16)
      const status = JSON.parse(await this.ckbCall('get_live_cell', JSON.stringify([{ tx_hash: outpoint.slice(0, 66), index }, false]))).result?.status
      return typeof status === 'string' ? status === 'live' : null
    } catch {
      return null
    }
  }

  /** The channel kept here, set aside under `tag` with what belongs to it (settleAside runs it).
   * Never over another set aside under the same tag: its keys would go. */
  private async setAside(tag: string) {
    // Its last save's backup first, so the copy set aside counts as the gateway's; not kept, it is
    // dropped below: the LSP heard nothing of that state (backupFirst).
    await this.backupFirst().catch((e) => this.log(`The backup was not kept before setting the channel aside: ${message(e)}`))
    let aside = `-closed-${tag}`
    while ((await this.store.get(STATE + aside)) !== undefined) aside = `-closed-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')}`
    const id = this.tenantId
    for (const name of ASIDE_NAMES) await this.store.move(name, name + aside)
    // Left on its own, it goes aside with what it left: its share is said there (asideBack).
    if (this.state.left) this.set({ left: null })
    // The marks of a channel brought from its backup go with it, or it would come back as one that
    // takes payments.
    for (const name of [RETIRE, BROUGHT]) if (id && (await this.store.get(name)) === id) await this.store.move(name, name + aside)
    await this.store.remove(ASIDE_DONE + aside)
    await this.store.set(ASIDE_AT + aside, String(Date.now()))
    this.backupDue = null
  }

  /** A channel set aside here that is still open comes back as the channel kept here: its own copy,
   * with what went aside with it, the one kept now set aside in its place. The host starts again;
   * nothing of either is lost. Its key and its count are checked at the gateway's first answer
   * (afterBack). */
  private async bringBack(tag: string, tenantId: string) {
    this.bringing = true
    this.set({ asideChecking: true })
    const aside = `-closed-${tag}`
    if ((await this.store.get(STATE)) !== undefined) await this.setAside(this.tenantId ? this.tenantId.slice(0, 8) : tag)
    await this.store.remove(RETIRE)
    await this.store.remove(BROUGHT)
    for (const name of [...ASIDE_NAMES, RETIRE, BROUGHT]) await this.store.move(name + aside, name)
    await this.store.remove(ASIDE_AT + aside)
    await this.store.set(BACK, tenantId)
    this.log(`The channel set aside as ${tag} is still open: it is the channel kept here again.`)
    this.running = false
    this.bye()
    this.host.restart()
  }

  /** A channel set aside, on its way back (`back`) or not any more (null), in `asideBack`. */
  private asideOnItsWay(channel: string, back: { since: number; token: FiberScript | null; share?: bigint } | null) {
    const list = this.state.asideBack
    const was = list.find((a) => a.channel === channel)
    if (!back) {
      if (was) this.set({ asideBack: list.filter((a) => a !== was) })
      return
    }
    if (was && was.since === back.since && sameScript(was.token, back.token) && was.share === back.share) return
    const now = { channel, since: back.since, token: back.token, ...(back.share !== undefined ? { share: back.share } : {}) }
    this.set({ asideBack: was ? list.map((a) => (a === was ? now : a)) : [...list, now] })
  }

  /** The payments of a channel set aside still on their way once it is settled, ended for good:
   * paid when the LSP's node, asked as that channel's tenant, or one of its settlement transactions
   * on chain holds the secret; otherwise failed, and `back` for one that had left, its amount in the
   * settled share (a 14:00 test payment of 1.005 CKB, back inside the payer's share, 2026-10-30: the node never
   * answered for it, and Activity kept it on its way). Not the node alone: it kept a test
   * payment "Created" while the LSP took another's secret on chain. False when the node or the
   * chain could not say just now. */
  private async endAsideSent(channel: string, token: string, outpoint: string | undefined): Promise<boolean> {
    const open = (await this.sentList()).filter((p) => !p.resolved && p.channel_id?.toLowerCase() === channel.toLowerCase())
    if (!open.length) return true
    const ends = new Map<string, Partial<Sent>>()
    let secrets: Map<string, string> | undefined
    for (const p of open) {
      let secret: string | null
      try {
        secret = JSON.parse(await this.signerHost.lsp('get_payment', JSON.stringify({ payment_hash: p.payment_hash }), token)).result?.payment_preimage ?? null
      } catch (e) {
        this.log(`The payment ${p.payment_hash.slice(0, 10)} of an old channel could not be read just now: ${message(e)}`)
        return false
      }
      if (!secret) {
        // Without its funding cell the chain cannot be read for it: it stays as it is.
        if (!outpoint) continue
        if (!secrets) {
          const witnesses = await this.settlementWitnesses(outpoint)
          if (!witnesses) return false
          secrets = await secretsIn(witnesses)
        }
        secret = secrets.get(p.payment_hash.toLowerCase()) ?? null
      }
      ends.set(p.payment_hash, secret ? { resolved: true, status: 'Paid', preimage: secret } : { resolved: true, status: 'Failed', ...(p.status !== 'Created' ? { back: true as const } : {}) })
    }
    if (!ends.size) return true
    await this.editSent((now) => now.map((p) => (ends.has(p.payment_hash) ? { ...p, ...ends.get(p.payment_hash) } : p)))
    for (const [hash, end] of ends) {
      const p = open.find((x) => x.payment_hash === hash)!
      this.log(
        end.status === 'Paid'
          ? `Paid ${ckb(BigInt(p.amount))} CKB (${hash.slice(0, 10)}), in a channel closed since.`
          : `The payment ${hash.slice(0, 10)} of a channel closed since did not go; ${end.back ? 'its amount came back with that channel.' : 'nothing of it left.'}`,
      )
      for (const fn of this.sentListeners) fn(hash, end.status === 'Paid')
    }
    return true
  }

  /** A channel set aside and over before its payments were ended there (endAsideSent came later):
   * ended once, at start, when one of them is still on its way. */
  private async endDoneAside(name: string, id: string) {
    try {
      const kept = await this.read<ChannelInfo>(`${CHANNEL_INFO}-closed-${id}`, {})
      const channel = kept.channel_id
      if (!channel || !(await this.sentList()).some((p) => !p.resolved && p.channel_id?.toLowerCase() === channel.toLowerCase())) return
      const aside = await this.wasm!.LspSigner.create({ ...this.signerHost, save: (state: string) => this.store.set(name, state, SEALED) }, await this.store.get(name, SEALED))
      await aside.configureChain()
      const token: string | undefined = JSON.parse(await aside.status()).tenant_token
      if (token) await this.endAsideSent(channel, token, kept.outpoint)
    } catch (e) {
      this.log(`Old channel ${id}, its payments: ${message(e)}`)
    }
  }

  /** The witnesses of the transactions that spent a channel's funding cell, then each cell of its
   * commitment in turn (a lock whose first 20 bytes stay those of the commitment's), in order; null
   * while one of them is unspent, or when the chain cannot say. */
  private async settlementWitnesses(outpoint: string): Promise<string[] | null> {
    if (!/^0x[0-9a-fA-F]{72}$/.test(outpoint)) return null
    const call = async (method: string, params: unknown[]) => {
      const body = JSON.parse(await this.ckbCall(method, JSON.stringify(params)))
      if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
      return body.result
    }
    type Tx = { inputs: { previous_output: { tx_hash: string; index: string } }[]; outputs: { lock: { code_hash: string; hash_type: string; args: string } }[]; witnesses: string[] }
    try {
      let cell = { txHash: outpoint.slice(0, 66).toLowerCase(), index: Number(BigInt('0x' + outpoint.slice(66).match(/../g)!.reverse().join(''))) }
      let prefix: string | null = null
      const witnesses: string[] = []
      for (let step = 0; step < 64; step++) {
        const lock = ((await call('get_transaction', [cell.txHash]))?.transaction as Tx | undefined)?.outputs[cell.index]?.lock
        if (!lock) return null
        const found = (await call('get_transactions', [{ script: lock, script_type: 'lock', script_search_mode: 'exact' }, 'asc', '0x64']))?.objects as { tx_hash: string; io_type: string }[] | undefined
        let spent: { hash: string; tx: Tx } | null = null
        for (const o of found ?? []) {
          if (o.io_type !== 'input') continue
          const tx = (await call('get_transaction', [o.tx_hash]))?.transaction as Tx | undefined
          if (tx?.inputs.some((i) => i.previous_output.tx_hash.toLowerCase() === cell.txHash && Number(i.previous_output.index) === cell.index)) spent = { hash: o.tx_hash.toLowerCase(), tx }
        }
        if (!spent) return null
        witnesses.push(...spent.tx.witnesses)
        // A commitment's lock carries 36 bytes or more; a close together pays wallets, and ends here.
        const ofIt = (args: string) => args.length >= 2 + 72 && (prefix ??= args.slice(0, 42).toLowerCase()) === args.slice(0, 42).toLowerCase()
        const next = spent.tx.outputs.findIndex((o) => ofIt(o.lock.args))
        if (next < 0) return witnesses
        cell = { txHash: spent.hash, index: next }
      }
      return null
    } catch (e) {
      this.log(`The chain could not say how a closed channel ended: ${message(e)}`)
      return null
    }
  }

  /** With no channel kept here (after "Top up again", before the next top-up), the channels set aside
   * here, asked whether one is still open: one that is comes back as the channel kept here and the
   * host starts again with it. Nothing is registered with the LSP for this, and nothing waits for a
   * top-up to start the signer: a channel set aside still open was found only then, or by its
   * passkey, and one kept with none never. False when none is open. */
  checkAside(): Promise<boolean> {
    if (this.booting) return Promise.resolve(false)
    // Asked once at a time; a start meanwhile waits for it (start).
    if (!this.checking)
      this.checking = this.askAside().finally(() => {
        this.checking = null
      })
    return this.checking
  }

  private async askAside(): Promise<boolean> {
    if ((await this.store.get(STATE)) !== undefined) return false
    const prefix = `${STATE}-closed-`
    const names = await this.store.names(prefix)
    if (!names.length) return false
    const lock = await this.host.acquire(this.config.lockName)
    if (!lock.held) return false
    this.set({ asideChecking: true })
    try {
      this.device ||= await this.deviceId()
      if (!this.wasm) {
        this.wasm = await import('./signer/cellula_lsp_signer.js')
        await this.host.initSigner(this.wasm.default)
      }
      for (const name of names) {
        const id = name.slice(prefix.length)
        if (await this.store.get(`${ASIDE_DONE}-closed-${id}`)) continue
        // Set aside just now by startOver, which sets aside none open (and its bye is still fresh).
        if (Date.now() - Number(await this.store.get(`${ASIDE_AT}-closed-${id}`)) < ASIDE_FIRST_MS) continue
        try {
          const aside = await this.wasm.LspSigner.create({ ...this.signerHost, save: (state: string) => this.store.set(name, state, SEALED) }, await this.store.get(name, SEALED))
          await aside.configureChain()
          await this.tellTokens([], aside)
          const status = JSON.parse(await aside.status())
          const channel: string | undefined = status.bound_channel_ids[0]
          if (!status.tenant_token || !channel) continue
          const body = JSON.parse(await this.signerHost.lsp('list_channels', JSON.stringify({ include_closed: true }), status.tenant_token))
          const listed = body.result?.channels as RawChannel[] | undefined
          const c = listed?.find((x) => x.channel_id === channel)
          if (c && stillOpen(c)) {
            await this.bringBack(id, status.tenant_id ?? '')
            return true
          }
          if (asideOver(c, listed)) await this.store.set(`${ASIDE_DONE}-closed-${id}`, '1')
        } catch (e) {
          this.log(`Old channel ${id}: ${message(e)}`)
        }
      }
      return false
    } finally {
      lock.release()
      if (!this.bringing) this.set({ asideChecking: false })
    }
  }

  /** One set aside here and found still open: it comes back when the channel kept here is not open
   * (none, never funded, or closed) and nothing is under way. */
  private async backAside(tag: string, tenantId: string) {
    if (!this.bringing && !this.state.opening && !this.state.closing && this.notOpenHere()) await this.bringBack(tag, tenantId)
  }

  /** The channel kept here is known not to be open, as this page read it: none bound to its tenant,
   * never funded, or closed. */
  private notOpenHere(): boolean {
    return !!this.tenantId && (!this.channelId || this.state.unfunded || !!this.state.channel?.closed)
  }

  /** Channels set aside for a new one may still have money on chain after a force close, and
   * only their own signer can sign it back: each runs for its settlements only, until settled.
   * One still open is not signed for here (its signatures go with its backup, which only the channel
   * kept here writes) and comes back as the channel kept here when that one is not open (backAside).
   * The first rounds of those set aside before this page answer `asideChecking`. */
  private async settleAside() {
    let first!: () => void
    this.asideFirst = new Promise<void>((r) => (first = r))
    const prefix = `${STATE}-closed-`
    const names = await this.store.names(prefix)
    const c = this.state.channel
    // The channel kept here is open: none set aside comes back now, so none is waited for.
    if (this.channelId && !this.state.unfunded && !c?.closed) this.set({ asideChecking: false })
    // One for the loop below, one for each round asked at once; all in, or ASIDE_CHECK_MS gone.
    let waiting = 1
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(cap)
      first()
      if (!this.bringing) this.set({ asideChecking: false })
    }
    const answered = () => --waiting <= 0 && settle()
    const cap = setTimeout(settle, ASIDE_CHECK_MS)
    for (const name of names) {
      const id = name.slice(prefix.length)
      if (await this.store.get(`${ASIDE_DONE}-closed-${id}`)) {
        void this.endDoneAside(name, id)
        continue
      }
      const at = Number(await this.store.get(`${ASIDE_AT}-closed-${id}`))
      // Set aside just now by startOver, which said bye for it seconds ago: the gateway refuses its
      // tenant's calls for a while after a bye (BYE_QUIET, 10 s), 409 in the console. It is not open (startOver), so nothing waits for it.
      const wait = at > 0 ? Math.max(0, at + ASIDE_FIRST_MS - Date.now()) : 0
      if (!wait) waiting++
      let told = !!wait
      const tell = () => {
        if (told) return
        told = true
        answered()
      }
      void (async () => {
        const stored = await this.store.get(name, SEALED)
        const aside = await this.wasm!.LspSigner.create({ ...this.signerHost, save: (state: string) => this.store.set(name, state, SEALED) }, stored)
        await aside.configureChain()
        await this.tellTokens([], aside)
        const status = JSON.parse(await aside.status())
        const asideToken: string = status.tenant_token
        const asideChannel: string | undefined = status.bound_channel_ids[0]
        const asideTenant: string = status.tenant_id ?? ''
        if (!asideToken || !asideChannel) return tell()
        let timer: ReturnType<typeof setInterval> | undefined
        const host = this.signerHost
        const note = (t: string) => this.log(t)
        const stop = () => {
          clearInterval(timer)
          timer = undefined
        }
        // Rounds of ASIDE_ROUND_MS to wait before the next ask, and what the last ask listed: a side
        // that stays closing as it was, with nothing signed, is asked every 10 s for a minute (ASIDE_CALM
        // rounds), then twice as long after each ask.
        let every = 1
        let skip = 0
        let said = ''
        let calm = 0
        let busy = false
        // Its share, read once from its own signer while it is on its way back (asideBack).
        let share: bigint | undefined
        let shareTries = 0
        const since = at > 0 ? at : Date.now()
        const coming = async (c: RawChannel | undefined) => {
          if (!onItsWay(c)) return
          if (share === undefined && shareTries < 3) {
            shareTries++
            try {
              share = (await recoveryOf(aside, (method, params) => this.ckbCall(method, params), () => this.keptPreimages(`-closed-${id}`)).then((r) => r.status())).share
            } catch (e) {
              note(`Old channel ${id}, its share: ${message(e)}`)
            }
          }
          this.asideOnItsWay(asideChannel, { since, token: c.funding_udt_type_script ?? null, share })
        }
        const round = async () => {
          if (busy) return
          if (skip > 0) return void skip--
          busy = true
          try {
            const body = JSON.parse(await host.lsp('list_channels', JSON.stringify({ include_closed: true }), asideToken))
            const listed = body.result?.channels as RawChannel[] | undefined
            const c = listed?.find((x) => x.channel_id === asideChannel)
            if (c && stillOpen(c)) {
              if (!this.asideOpen.has(id)) note(`Old channel ${id} is still open.`)
              this.asideOpen.set(id, asideTenant)
              this.asideOnItsWay(asideChannel, null)
              tell()
              return await this.backAside(id, asideTenant)
            }
            this.asideOpen.delete(id)
            tell()
            if (asideOver(c, listed)) {
              // Its payments still on their way end with it; asked again next round when they cannot be.
              if (!(await this.endAsideSent(asideChannel, asideToken, c?.channel_outpoint ?? (await this.read<ChannelInfo>(`${CHANNEL_INFO}-closed-${id}`, {})).outpoint))) return
              // Settled, or the LSP lists it no more (an opening never signed, dropped): each was asked
              // about every 10 s for good (five on one browser),
              // and at each start after (a tester's phone, 2026-10-27).
              stop()
              this.asideOnItsWay(asideChannel, null)
              await this.store.set(`${ASIDE_DONE}-closed-${id}`, '1')
              return note(c ? `Old channel ${id} is settled: nothing of yours is left in it.` : `Old channel ${id} was never opened: nothing of yours is in it.`)
            }
            // Its tenant's side still says closing, as it can for good after the LSP's own closed: the
            // chain says whether it is over (closedOnChain, for the channel kept here).
            if (c?.state.state_name === 'ShuttingDown' && (await this.asideSettledOnChain(c, aside, `-closed-${id}`))) {
              if (!(await this.endAsideSent(asideChannel, asideToken, c.channel_outpoint))) return
              stop()
              this.asideOnItsWay(asideChannel, null)
              await this.store.set(`${ASIDE_DONE}-closed-${id}`, '1')
              return note(`Old channel ${id} is closed on chain: nothing of yours is left in it.`)
            }
            await coming(c)
            const done = JSON.parse(await aside.poll())
            if (done.watchtower) note(`Old channel ${id}: signed ${done.watchtower} settlement(s); that money goes back to your wallet.`)
            const now = c ? `${c.state.state_name} ${c.state.state_flags ?? ''}` : ''
            const quiet = onItsWay(c) && now === said && !done.signed && !done.watchtower
            said = now
            calm = quiet ? calm + 1 : 0
            every = calm < ASIDE_CALM ? 1 : Math.min(every * 2, ASIDE_SLOWEST_MS / ASIDE_ROUND_MS)
            skip = every - 1
          } catch (e) {
            tell()
            note(`Old channel ${id}: ${message(e)}`)
          } finally {
            busy = false
          }
        }
        setTimeout(() => {
          timer = setInterval(round, ASIDE_ROUND_MS)
          void round()
        }, wait)
      })().catch((e) => {
        tell()
        this.log(`Old channel ${id} did not start: ${message(e)}`)
      })
    }
    answered()
  }
  /** Leave without the LSP: close on chain with the latest commitment both sides
   * signed, then, once its delay has passed, take this side's share back to the lock the channel
   * was opened with. The signer comes from this device's own copy, which is never behind what
   * the LSP has seen, and checks the public CKB nodes; nothing here asks the gateway or the LSP,
   * and no backup is sent. The channel stops signing here first, so nothing newer is signed. */
  async recovery(): Promise<Recovery> {
    return this.recoveryFor(true)
  }

  /** `leave`: the person takes it out on their own (recovery()), and from here no start may join the
   * LSP. Not for the session's own look at a channel closed on chain (closedOnChain): a normal Take out
   * passes there while the LSP lists it closing, and leaving then held every later start, so the
   * balance taken out showed only after the app was opened again (2026-11-05). */
  private async recoveryFor(leave: boolean): Promise<Recovery> {
    if (this.state.phase === 'elsewhere') throw new Error('Your channel is open in another tab of this browser. Close that tab first.')
    // From here this device leaves on its own: a start waiting at join() never signs on.
    if (leave) this.leaving = true
    if (this.running) {
      this.running = false
      this.bye()
    } else if (!this.booting) {
      await this.checking?.catch(() => false)
      const lock = await this.host.acquire(this.config.lockName)
      if (!lock.held) throw new Error('Your channel is open in another tab of this browser. Close that tab first.')
    }
    if (!this.wasm) {
      this.wasm = await import('./signer/cellula_lsp_signer.js')
      await this.host.initSigner(this.wasm.default)
    }
    const state = await this.store.get(STATE, SEALED)
    if (!state) throw new Error('No channel is kept on this device.')
    const signer = await this.wasm.LspSigner.create(
      {
        lsp: async () => {
          throw new Error('leaving without the LSP does not ask it anything')
        },
        ckb: (method: string, params: string) => this.ckbCall(method, params),
        save: (saved: string) => this.store.set(STATE, saved, SEALED),
      },
      state,
    )
    await signer.configureChain()
    await this.tellTokens([], signer)
    const recovery = await recoveryOf(signer, this.ckbCall, () => this.keptPreimages())
    // Claims read the chain and stand on any copy; closing needs this one to be the newest.
    return {
      ...recovery,
      // Nothing left in the closed channel: what was kept of leaving on its own goes.
      status: async () => {
        const s = await recovery.status()
        if (s.published && s.next.kind === 'done' && this.state.left) await this.forgetLeft()
        return s
      },
      publish: async () => {
        const refused = await this.leaveRefusal()
        if (refused) throw new Error(refused)
        const hash = await recovery.publish()
        // Kept with its share, so the next start says it at once, even with the LSP away.
        const share = await recovery.status().then((s) => s.share, () => null)
        const token = !!(JSON.parse((await this.store.get(CHANNEL_INFO)) ?? '{}') as ChannelInfo).reserve
        if (share !== null) {
          const left = { share, token, at: Date.now() }
          await this.store.set(LEFT, JSON.stringify({ share: share.toString(), token, at: left.at }))
          this.set({ left })
        }
        return hash
      },
    }
  }

  /** What was kept of leaving on its own (LEFT), read: null when nothing is, or what is kept cannot be read. */
  private async keptLeft(): Promise<FiberState['left']> {
    try {
      const v = JSON.parse((await this.store.get(LEFT)) ?? 'null') as { share: string; token: boolean; at: number } | null
      return v ? { share: BigInt(v.share), token: !!v.token, at: v.at } : null
    } catch {
      return null
    }
  }

  private async forgetLeft() {
    await this.store.remove(LEFT)
    this.set({ left: null })
  }

  /** A recovery file of the channel kept here, sealed with `passphrase` (recovery-file.ts): what
   * `recoveryFromFile` takes out with, on any copy of the recovery page, with nothing of ours
   * online. It is a copy of this moment: once the channel moves on (a payment), make a new one. */
  async recoveryFile(passphrase: string): Promise<string> {
    const state = await this.store.get(STATE, SEALED)
    if (!state) throw new Error('No channel is kept on this device.')
    // A file of a brought copy would take its possibly old state where closing alone is allowed.
    if (await this.store.get(BROUGHT))
      throw new Error('This channel was brought here from its backup, which may be older than its last state: a recovery file of it could close it with that old state. Close it together with the LSP.')
    // The file carries the channel's keys, so it asks for the passkey that keeps the channel first,
    // as a close does.
    await this.stepUp()
    const channelId = this.channelId ?? (JSON.parse(state).bound_channel_ids?.[0] as string | undefined) ?? ''
    if (!channelId) throw new Error('This device holds no channel yet.')
    // The signer's word for the network; a node's URL only when it has not said (a mainnet
    // node without "mainnet" in its URL would label the file testnet).
    const network = this.network ?? (this.config.ckbNodes.some((n) => /mainnet/.test(n)) ? 'mainnet' : 'testnet')
    const tokens = await this.tokenCodes()
    return sealRecoveryFile({ state, preimages: await this.keptPreimages(), ...(tokens.length ? { tokens } : {}) }, passphrase, { network, channelId })
  }

  /** The channel kept here as it is now, as a short digest; empty when none is kept. A recovery
   * file saved at another stamp is out of date (the channel signed since, a payment), and taking a
   * balance out with it can lose it, so a screen asks for a new one when the two differ. */
  async recoveryStamp(): Promise<string> {
    const state = await this.store.get(STATE, SEALED)
    if (!state) return ''
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state)))
    return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** Keep the channel with a passkey from this browser (one opened before passkeys, or one
   * whose passkey lives elsewhere). */
  async keep() {
    const keeper = this.host.keeper
    if (!keeper) throw new Error('this host keeps no passkey')
    await this.start()
    if (await this.backupVersion()) {
      const unlocked = await keeper.unlock(this.tenantId, await this.backupVersion())
      if (unlocked.tenantId !== this.tenantId) throw new Error('that passkey keeps another channel')
      this.backupKey = unlocked.key
      this.access = unlocked.access
    } else {
      const made = await keeper.create(this.tenantId)
      this.backupKey = made.key
      this.access = made.access
    }
    this.set({ rekeep: false })
    await this.backUp((await this.store.get(STATE, SEALED)) ?? '')
  }

  /** Bring a kept channel here with its passkey. */
  async restore(expected?: string) {
    const keeper = this.host.keeper
    if (!keeper) throw new Error('this host keeps no passkey')
    const unlocked = await keeper.unlock(expected)
    if (expected && unlocked.tenantId !== expected) throw new Error('that passkey keeps another channel')
    const r = await fetch(`${this.config.gateway}/backup/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant_id: unlocked.tenantId, access: unlocked.access }) })
    const saved = await r.json()
    if (!r.ok) throw new Error(saved.error ?? 'nothing is kept for that passkey')
    // Signed on another device right now: brought here, both copies are only closed, and a payment
    // there would stick (a tester's phone, 2026-10-30). Closed there, or left a minute, it comes.
    if (saved.in_use === true) throw new Error(IN_USE_SAYS)
    // Never an older copy over the one here, as catchUp: the same channel only moves
    // forward, or its signer could sign again what it signed already.
    const here = !!(await this.store.get(STATE, SEALED))
    const same = here && !!this.tenantId && unlocked.tenantId === this.tenantId
    if (same && !(saved.version > (await this.backupVersion()))) throw new Error('the copy kept is not newer than the one here, so it was not taken')
    // With nothing of it here, the passkey's own mark is the measure: the gateway cannot write it.
    // A copy newer than the passkey's last use rests on the gateway.
    if (unlocked.seen !== undefined && !(saved.version >= unlocked.seen)) throw new Error('the copy kept is older than the one your passkey last saw, so it was not taken')
    // Another channel kept here, or one this page cannot name yet, is never written over: it is
    // set aside, as for a new channel, so its own signer still settles what it holds on chain.
    const opened = await keeper.open(unlocked.key, unlocked.tenantId, saved.version, saved)
    // Never in place of a channel kept here that is open, or not known not to be: it would be set aside while it holds money.
    if (here && !same && !this.notOpenHere()) throw new Error(this.state.channel && !this.state.channel.closed ? OPEN_HERE : NOT_READ_HERE)
    if (here && !same) await this.setAside(this.tenantId ? this.tenantId.slice(0, 8) : (await this.recoveryStamp()).slice(0, 8))
    await this.takeBackup(opened, unlocked.tenantId)
    if (!same) {
      await this.store.set(RETIRE, unlocked.tenantId)
      await this.store.set(BROUGHT, unlocked.tenantId)
    }
    await this.setBackupVersion(saved.version)
    this.host.restart()
  }

  /** The signer's wasm is loaded: invoices can be read and paid. */
  get loaded(): boolean {
    return !!this.wasm
  }

  /** What an invoice says, read by the signer itself, so no server's reading is trusted. */
  parseInvoice(invoice: string): ReadInvoice {
    if (!this.wasm) throw new Error('no ready channel to pay from')
    return JSON.parse(this.wasm.parseInvoice(invoice)) as ReadInvoice
  }

  /** Read an invoice without starting the channel: only the signer's wasm loads, no tenant is
   * registered (a checkout shows what it is asked to pay before anything else runs). */
  async readInvoice(invoice: string): Promise<ReadInvoice> {
    if (!this.wasm) {
      const wasm = await import('./signer/cellula_lsp_signer.js')
      await this.host.initSigner(wasm.default)
      this.wasm ??= wasm
    }
    return this.parseInvoice(invoice)
  }

  /** Pay an invoice: the signer reads it itself, and may send no more than its amount plus the
   * most accepted in routing fees (feeCap: 1% and 0.01 CKB, less on small payments). Returns its
   * payment hash. */
  async pay(invoice: string, chosen?: bigint): Promise<string> {
    return this.send(invoice, chosen, false)
  }

  private async send(invoice: string, chosen: bigint | undefined, fee: boolean): Promise<string> {
    if (!this.channelId || !this.state.channel?.ready || !this.wasm) throw new Error('no ready channel to pay from')
    if (this.state.brought) throw new Error(BROUGHT_SAYS)
    // The opening fee first, once: the gateway takes no other payment until it is
    // paid, and the person agreed to it when the channel was opened. Payments started together
    // wait for the same one (payOpeningFee).
    if (!fee && this.state.feeDue > 0n) await this.payOpeningFee()
    const key = (k: string) => k.toLowerCase().replace(/^0x/, '')
    const read = this.parseInvoice(invoice)
    const own = fee || !read.payee || key(read.payee) === key(this.config.lspPubkey) ? null : await this.outsideCode(invoice, read)
    if (own) invoice = own
    const inv = own ? this.parseInvoice(own) : read
    if (inv.currency.toLowerCase() !== this.config.currency.toLowerCase()) throw new Error(`that invoice is for ${inv.currency}, not ${this.config.currency === 'Fibt' ? 'testnet' : 'mainnet'}`)
    // An invoice with no amount of its own is paid what the payer chooses; one with an amount,
    // exactly that.
    if (!inv.amount && !chosen) throw new Error('that invoice does not say how much')
    if (inv.amount && chosen !== undefined && BigInt(inv.amount) !== chosen) throw new Error('that invoice asks for another amount')
    if (inv.expired) throw new Error('that invoice has expired')
    // A Fiber balance pays only in what it holds: CKB, or its token.
    const holds = this.state.channel.token
    if (!sameScript(holds, inv.udt_type_script ?? null)) throw new Error(holds ? 'this Fiber balance holds a token, and that invoice asks for something else' : 'that invoice asks for a token, and this Fiber balance holds CKB')
    const before = (await this.sentList()).find((p) => p.payment_hash === inv.payment_hash)
    if (before) throw new Error(before.status === 'Failed' ? 'paying that invoice failed from here, and it cannot be tried again: ask for a new one' : 'that invoice was already paid from here')
    const amount = inv.amount ? BigInt(inv.amount) : chosen!
    if (amount <= 0n) throw new Error('a payment pays something')
    // The passkey for this payment when it, with those made without it lately, passes the step-up
    // amount (stepup.ts); once asked, the count starts again.
    const asked = Date.now()
    this.quiet = this.quiet.filter((p) => asked - p.at < QUIET_MS)
    const decimals = this.state.channel.unit?.decimals ?? 8
    if (needsPasskey(this.quiet, amount, this.config.stepUpCkb * 10n ** BigInt(decimals), asked)) {
      await this.stepUp()
      this.quiet = []
    } else this.quiet.push({ at: asked, amount })
    await this.store.set(QUIET, JSON.stringify(this.quiet.map((p) => ({ at: p.at, amount: p.amount.toString() }))), SEALED)
    const maxFee = feeCap(amount, decimals)
    // A payment to the LSP's own node (its opening fee) goes straight over the channel: the LSP is
    // not its own trampoline.
    const direct = !!inv.payee && key(inv.payee) === key(this.config.lspPubkey)
    const send = { invoice, ...(inv.amount ? {} : { amount: hex(amount) }), max_fee_amount: hex(maxFee), ...(direct ? {} : { trampoline_hops: [this.config.lspPubkey] }) }
    for (let attempt = 1; ; attempt++) {
      try {
        await this.lsp('send_payment', { ...send, dry_run: true })
        break
      } catch (e) {
        if (attempt >= ROUTE_TRIES || !NOT_ROUTABLE_YET.test(message(e))) throw e
        await sleep(2000)
      }
    }
    const now = Date.now()
    await this.signer!.authorizePayment(
      this.channelId,
      JSON.stringify({
        payment_hash: inv.payment_hash,
        hash_algorithm: inv.hash_algorithm,
        inbound: false,
        amount: Number(amount + maxFee),
        expires_at_ms: inv.expiry_ms ? inv.timestamp_ms + inv.expiry_ms : now + 3_600_000,
        min_tlc_expiry_delta_ms: 1,
        max_tlc_expiry_ms: now + 14 * DAY,
      }),
    )
    const channelId = this.channelId
    // The opening fee is named as it is written, so a restart right after cannot pay it again; and
    // when its invoice ends, so one the node never took can end (resolveSent).
    const expires = inv.expiry_ms ? inv.timestamp_ms + inv.expiry_ms : now + 3_600_000
    await this.editSent((list) => [...list, { channel_id: channelId, payment_hash: inv.payment_hash, amount: amount.toString(), status: 'Created', at: Date.now(), expires_at: expires, ...(fee ? { what: 'fee' as const } : {}) }])
    // Its signatures follow at once: the loop is woken for them.
    this.stir(60_000)
    const r = await this.lsp<{ status: string }>('send_payment', send)
    this.log(`Paying ${ckb(amount)} CKB (${inv.payment_hash.slice(0, 10)}): ${r.status}`)
    return inv.payment_hash
  }

  /** The wallet's own invoice behind one of the gateway's plain ones (gateway /outside), when it is
   * one: paid from here as it is, its payment goes out through the LSP toward the gateway's
   * receiving node, and the LSP hands it to the wallet behind it by its hash with the part meant for
   * that node, which the wallet cannot read. Its own invoice is the
   * same payment, paid the way two wallets on this LSP pay each other. The signer reads what the
   * gateway gives, and it is taken only as the same payment, amount and network. Null for any
   * other invoice, or when the gateway does not answer: then the invoice is paid as it is. */
  private async outsideCode(invoice: string, read: ReadInvoice): Promise<string | null> {
    if (!this.token) return null
    try {
      const r = await this.post(`${this.config.gateway}/outside-code`, JSON.stringify({ payment_hash: read.payment_hash, invoice }), this.token)
      if (!r.ok) return null
      const body = await r.json()
      if (typeof body.invoice !== 'string') return null
      const own = this.parseInvoice(body.invoice)
      return own.payment_hash === read.payment_hash && own.amount === read.amount && own.currency === read.currency && !own.expired ? body.invoice : null
    } catch {
      return null
    }
  }

  /** Whether a TLC of ours for this payment is still in the channel, read from the LSP just now. */
  private async outboundPending(channelId: string, paymentHash: string): Promise<boolean> {
    const { channels } = await this.lsp<{ channels: RawChannel[] }>('list_channels', { include_closed: false })
    const c = channels.find((x) => x.channel_id === channelId)
    return !!c?.pending_tlcs?.some((t) => t.payment_hash === paymentHash && !!t.status && 'Outbound' in t.status && !removalConfirmed(t.status))
  }

  /** A payment sent from here, as this host last saw it: `Paid` with the payee's secret (the
   * receipt), `Failed`, or the node's word while it is on its way; undefined if never sent. */
  async sentPayment(paymentHash: string): Promise<{ status: string; preimage?: string } | undefined> {
    const p = (await this.sentList()).find((x) => x.payment_hash === paymentHash)
    return p && { status: p.status, preimage: p.preimage }
  }

  /** Resolves true once the payee's secret is here for a payment sent from this host (it is
   * paid: the secret is the receipt), or false once it failed and its amount stayed here. Sooner
   * than the LSP's delivery records, which wait for the channel to settle it. */
  whenSent(paymentHash: string): Promise<boolean> {
    return new Promise((resolve) => {
      const fn = (hash: string, paid: boolean) => {
        if (hash !== paymentHash) return
        this.sentListeners.delete(fn)
        resolve(paid)
      }
      // Listening first, then the list: one resolved in between is not missed.
      this.sentListeners.add(fn)
      void this.sentList().then((list) => {
        const done = list.find((p) => p.payment_hash === paymentHash && p.resolved)
        if (done) fn(paymentHash, done.status === 'Paid')
      })
    })
  }

  /** How each payment sent from here ended: the payee's secret lets the signer accept its TLC as
   * paid, a failure lets it accept the refund; before either it signs neither. */
  private async resolveSent() {
    const list = await this.sentList()
    // What changed, written over the list as it is then (editSent), not over this copy.
    const updates = new Map<string, Partial<Sent>>()
    for (const p of list) {
      if (p.resolved) continue
      // A payment of a channel closed before this one is its tenant's, which this one cannot read:
      // asked each round, the node said "Payment session not found" every 5 s (a tester's phone, after a
      // close by force and a new balance, 2026-10-30). Its end is on chain with that channel. With
      // no channel here yet (set aside for a new one), none is this one's.
      if (p.channel_id && p.channel_id.toLowerCase() !== (this.channelId ?? '').toLowerCase()) continue
      // One payment the node cannot answer for does not keep the others, or the signing after
      // this, waiting.
      try {
        const r = await this.lsp<{ status: string; payment_preimage?: string | null; failed_error?: string | null; fee?: string | null }>('get_payment', { payment_hash: p.payment_hash })
        // The node can mark a payment Failed while its TLC is still out (a retry that found no route
        // fails the session; seen 2026-10-07: that TLC was paid 12 minutes later). A refund approved
        // then cannot become the payment it was, the TLC's removal is never signed, and the channel
        // stops. So a Failed payment with a TLC of ours still out waits for that TLC's end: the
        // node's report that its refund waits for us (from the tenant's own store), or the
        // payee's secret, which the node holds only once our TLC was paid.
        const failed = r.status === 'Failed'
        const out = failed && !REFUND_HELD.test(r.failed_error ?? '') && !r.payment_preimage ? await this.outboundPending(p.channel_id, p.payment_hash) : false
        if (r.payment_preimage) {
          await this.signer!.authorizeFulfillment(p.channel_id, p.payment_hash, r.payment_preimage)
          // What the routing cost, as the node counted it, for the payment's details in the wallet
          // (asked for by a tester, 2026-11-05).
          const fee = typeof r.fee === 'string' && /^0x[0-9a-f]+$/i.test(r.fee) ? BigInt(r.fee).toString() : undefined
          updates.set(p.payment_hash, { resolved: true, status: 'Paid', preimage: r.payment_preimage, ...(fee !== undefined ? { fee } : {}) })
          this.log(`Paid ${ckb(BigInt(p.amount))} CKB (${p.payment_hash.slice(0, 10)}).`)
        } else if (out) {
          if (p.status !== 'Out') {
            updates.set(p.payment_hash, { status: 'Out' })
            this.log(`The payment ${p.payment_hash.slice(0, 10)} is reported failed while it is still on its way: waiting for its end.`)
          }
        } else if (failed || REFUND_HELD.test(r.failed_error ?? '')) {
          // The LSP's node reports the failure as soon as it holds the removal: the
          // payment turns Failed only once this signer has signed that refund, so it must not wait
          // for "Failed" (2026-10-06, a failed payment held its channel for days). Only that report,
          // not any error a retry leaves behind, since a refund approved cannot become a payment.
          await this.signer!.authorizeCancellation(p.channel_id, p.payment_hash)
          updates.set(p.payment_hash, { resolved: true, status: 'Failed' })
          this.log(`The payment ${p.payment_hash.slice(0, 10)} failed (${r.failed_error ?? 'no reason given'}); its amount stays yours.`)
        } else if (r.status !== p.status) {
          updates.set(p.payment_hash, { status: r.status })
        }
      } catch (e) {
        // One written here that the node never took (stopped between writing it and sending it, or
        // send_payment failing after its dry run): the node has no such payment. Once its invoice
        // has ended it can never be sent, so it ends failed, and nothing waits on it for good.
        const ended = Date.now() > (p.expires_at ?? (p.at ?? 0) + DAY) + 60_000
        if (NEVER_SENT.test(message(e)) && ended && !(await this.outboundPending(p.channel_id, p.payment_hash).catch(() => true))) {
          updates.set(p.payment_hash, { resolved: true, status: 'Failed' })
          this.log(`The payment ${p.payment_hash.slice(0, 10)} never reached the LSP's node, and its invoice has ended: failed, its amount stays yours.`)
          continue
        }
        this.log(`The payment ${p.payment_hash.slice(0, 10)} could not be read just now: ${message(e)}`)
      }
    }
    if (updates.size) {
      await this.editSent((now) => now.map((p) => (updates.has(p.payment_hash) ? { ...p, ...updates.get(p.payment_hash) } : p)))
      // Said once written, as endAsideSent does: told inside the loop, whenSent resolved while
      // sentPayment still had no secret, and an agent had no receipt to show (testnet, 2026-10-31).
      for (const [hash, u] of updates) if (u.resolved) for (const fn of this.sentListeners) fn(hash, u.status === 'Paid')
      // A payment just paid leaves the balance as it is said paid, not after this turn's signing.
      if ([...updates.values()].some((u) => u.status === 'Paid')) await this.refreshChannel(true).catch(() => {})
      // What the channel holds now, at the next turn, not up to 3 s later.
      this.lastChannel = 0
    }
  }

  /** An invoice whose secret stays here: the signer is told the exact amount and the secret
   * first, and the LSP's node only gets the hash. */
  private async makeInvoice(amount: bigint, valid: number, link = true, description = this.config.invoiceDescription): Promise<Invoice> {
    if (this.state.brought) throw new Error(BROUGHT_SAYS)
    const preimage = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)))
    const paymentHash = ccc.hashCkb(preimage)
    const now = Date.now()
    const terms = invoiceTerms(paymentHash, amount, now, valid, this.delay.finalExpiryMs)
    await this.signer!.authorizeInvoice(this.channelId!, JSON.stringify(terms), preimage)
    // A token channel is paid in its token only: the invoice says so.
    const token = this.state.channel?.token
    const created = await this.lsp<{ invoice_address: string }>('new_invoice', {
      amount: hex(amount),
      currency: this.config.currency,
      description,
      expiry: hex(BigInt(valid / 1000)),
      final_expiry_delta: hex(BigInt(this.delay.finalExpiryMs)),
      allow_trampoline_routing: true,
      payment_hash: paymentHash,
      ...(token ? { udt_type_script: token } : {}),
    })
    const inv: Invoice = { channel_id: this.channelId!, payment_hash: paymentHash, preimage, amount: amount.toString(), address: created.invoice_address, status: 'Open', link, expires_at: now + valid, tlc_max: terms.max_tlc_expiry_ms, made_at: now }
    this.inv = [...this.inv, inv]
    await this.saveInvoices()
    return inv
  }

  /** An invoice with no amount of its own (a pay link's "any amount"): the signer keeps its
   * secret and authorizes it with the exact amount of the payment that comes for it, when that
   * lies within `least` and `most`; the LSP's node gets only the hash. */
  private async makeOpenInvoice(open: OpenLink, valid: number): Promise<Invoice> {
    if (this.state.brought) throw new Error(BROUGHT_SAYS)
    const preimage = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)))
    const paymentHash = ccc.hashCkb(preimage)
    const now = Date.now()
    const terms = invoiceTerms(paymentHash, open.most, now, valid, this.delay.finalExpiryMs)
    await this.signer!.authorizeOpenInvoice(this.channelId!, JSON.stringify(terms), open.least.toString(), preimage)
    const token = this.state.channel?.token
    const created = await this.lsp<{ invoice_address: string }>('new_invoice', {
      amount: '0x0',
      currency: this.config.currency,
      description: this.config.invoiceDescription,
      expiry: hex(BigInt(valid / 1000)),
      final_expiry_delta: hex(BigInt(this.delay.finalExpiryMs)),
      allow_trampoline_routing: true,
      payment_hash: paymentHash,
      ...(token ? { udt_type_script: token } : {}),
    })
    const inv: Invoice = { channel_id: this.channelId!, payment_hash: paymentHash, preimage, amount: '0', address: created.invoice_address, status: 'Open', link: true, open: true, expires_at: now + valid, tlc_max: terms.max_tlc_expiry_ms }
    this.inv = [...this.inv, inv]
    await this.saveInvoices()
    return inv
  }

  /** Release the secret of every invoice whose payment has arrived and is held for us. Link
   * invoices on offer are asked about every LINK_SWEEP_MS; while payments arrive, every round, those the
   * channel's TLCs coming in pay (each one call to the LSP: asking about all 132 of a keeper's
   * link took 10 to 13 s a round, maria.cell's keeper, 2026-10-27), or all of them when a TLC
   * coming in has no hash to tell its invoice by. An invoice made more than PLAIN_QUICK_MS ago is
   * asked about the same way: a wallet's Receive codes last 48 h (a P2P desk pays its buyer up to
   * 36 h after the order, 2026-11-03), and asked every round each one cost about 420 calls an hour
   * for as long as the page stayed open. */
  private async settleInvoices(now = false) {
    const receiving = !!this.state.channel?.receiving
    if (!receiving && !now && Date.now() - this.lastInvoiceCheck < Math.min(5000, this.config.loopFloorMs ?? 5000)) return
    this.lastInvoiceCheck = Date.now()
    const incoming = receiving ? this.incoming : new Set<string>()
    const linkTurn = Date.now() - this.linkInvoicesChecked > LINK_SWEEP_MS || incoming === null
    if (linkTurn) this.linkInvoicesChecked = Date.now()
    const list = this.inv
    const item = this.config.item
    let changed = false
    for (const inv of list) {
      if (['Paid', 'Cancelled', 'Expired'].includes(inv.status)) continue
      const aged = inv.made_at !== undefined && Date.now() - inv.made_at > PLAIN_QUICK_MS
      if ((inv.link || aged) && inv.status === 'Open' && !linkTurn && !incoming?.has(inv.payment_hash.toLowerCase())) continue
      const { status } = await this.lsp<{ status: string }>('get_invoice', { payment_hash: inv.payment_hash })
      if (status === 'Received' && !inv.released) {
        // An open invoice is paid what came, when its signer took it: within its bounds.
        if (inv.open && !inv.refused) {
          const came = JSON.parse(await this.signer!.openInvoice(inv.payment_hash)) as { came: string; taken: boolean } | null
          if (!came) continue
          if (came.taken) inv.amount = came.came
          else {
            inv.refused = true
            this.log(`A payment of ${ckb(BigInt(came.came))} CKB for an open ${item} invoice was outside its bounds; it goes back to its payer.`)
            changed = true
          }
        }
        if (!inv.refused) {
          try {
            await this.signer!.releasePreimage(inv.channel_id, inv.payment_hash, inv.preimage, 'Invoice')
            inv.released = true
            inv.paid_at = Date.now()
            this.log(`A ${ckb(BigInt(inv.amount))} CKB ${item} arrived; the signer checked it and released the secret.`)
            for (const fn of this.paidListeners) fn(inv.payment_hash, BigInt(inv.amount))
          } catch (e) {
            // A payment that did not match this invoice (its amount, or past its time limits) is
            // taken in cancelled by the signer, so the channel keeps moving: its secret stays
            // here. The other invoices are still looked at.
            if (!REFUSED_RELEASE.test(message(e))) throw e
            inv.refused = true
            this.log(`A payment for a ${ckb(BigInt(inv.amount))} CKB ${item} did not match its invoice; it goes back to its payer.`)
          }
          changed = true
        }
        // Cancelled, the invoice sends the payment back now; held, it would wait until the
        // invoice expires (a week for a link's). Asked again every round until the LSP agrees.
        if (inv.refused) {
          await this.lsp('cancel_invoice', { payment_hash: inv.payment_hash }).catch((e) => this.log(`Could not cancel the invoice yet: ${message(e)}`))
        }
      }
      if (status !== inv.status) {
        if (inv.link) this.linkChecked = 0
        inv.status = status
        changed = true
      }
    }
    if (changed) {
      this.stir()
      await this.saveInvoices()
    }
  }

  /** Pay the LSP's opening fee from this channel, once it is ready: the gateway takes
   * no other payment in or out until it is paid. Returns its payment hash, or null when nothing is
   * due. Resolves once the gateway has seen it paid, or after a minute of waiting for that. */
  async payOpeningFee(): Promise<string | null> {
    // One at a time: two payments started while it is due wait for the same one, or each would ask
    // the gateway, pass the check before either was written, and pay it twice.
    if (!this.feeRun) this.feeRun = this.payOpeningFeeOnce().finally(() => (this.feeRun = null))
    return this.feeRun
  }

  private async payOpeningFeeOnce(): Promise<string | null> {
    // Told to ask again (503 with retry_after: the gateway cannot say yet whether this opening is
    // free), it does, as lspTerms does.
    const ask = async () => {
      for (let waited = 0; ; ) {
        const r = await this.post(`${this.config.gateway}/fee`, '{}', this.token)
        const body = await r.json().catch(() => ({}))
        if (r.ok) return body as { due?: number; invoice?: string | null }
        const after = Number(body.retry_after) * 1000
        if (!(after > 0) || waited + after > TERMS_WAIT_MS) throw new Error(body.error ?? `the LSP answered ${r.status}`)
        waited += after
        await sleep(after)
      }
    }
    const due = await ask()
    if (!due.due || !due.invoice) {
      this.set({ feeDue: 0n })
      return null
    }
    await this.feeInvoiceAgreed(due.invoice)
    const hash = await this.send(due.invoice, undefined, true)
    // Named in the history as what it is, not as a payment to someone (historyOf, `what`).
    await this.editSent((list) => list.map((p) => (p.payment_hash === hash ? { ...p, what: 'fee' as const } : p)))
    for (let i = 0; i < 30; i++) {
      await sleep(2000)
      if (!(await ask().catch(() => ({ due: 1 }))).due) {
        this.set({ feeDue: 0n })
        this.log('Opening fee paid.')
        break
      }
    }
    // The balance as it is now, not as it was before the fee: a test on 2026-10-14 showed the
    // old one for a few seconds after the fee was paid.
    await this.refreshChannel(true).catch(() => {})
    return hash
  }

  /** The fee invoice the gateway made, checked before it is paid: to the LSP's own node, at most
   * the fee agreed when this device opened the channel (FEE_MOST in CKB where none was kept here),
   * and once: not while one is on its way, nor after one went through, by this host's own record. */
  private async feeInvoiceAgreed(invoice: string): Promise<void> {
    const read = this.parseInvoice(invoice)
    const key = (k: string) => k.toLowerCase().replace(/^0x/, '')
    if (!read.payee || key(read.payee) !== key(this.config.lspPubkey)) throw new Error("the opening fee's invoice is not the LSP's own, so it was not paid")
    if (!read.amount) throw new Error("the opening fee's invoice names no amount, so it was not paid")
    const fees = (await this.sentList()).filter((p) => p.what === 'fee' && p.channel_id === this.channelId)
    if (fees.some((p) => p.resolved && p.status === 'Paid')) throw new Error("this channel's opening fee is paid already, so it was not paid again")
    if (fees.some((p) => !p.resolved)) throw new Error("this channel's opening fee is on its way, so it was not paid again")
    const kept = await this.store.get(FEE_AGREED)
    const agreed = kept ? (JSON.parse(kept) as { channel: string | null; fee: string }) : null
    const most = agreed?.channel && agreed.channel === this.channelId ? BigInt(agreed.fee) : this.state.channel?.unit ? null : FEE_MOST
    const amount = BigInt(read.amount)
    if (most !== null && amount > most)
      throw new Error(`the opening fee's invoice asks ${amount} shannons, more than the ${most} agreed when this channel opened, so it was not paid`)
  }

  /** Rent more room to receive from the LSP: `room` shannons for `months` of 30 days,
   * asked with this tenant's token and paid from this channel. The room comes with this tenant's
   * next channel: take this one out and top up again once nothing is under way; the next opening
   * here moves the rent to its node (carryRents). Resolves once the gateway has seen it paid, or
   * with the rent unpaid after `waitMs`. */
  async rentRoom(room: bigint, months = 1, opts: { waitMs?: number } = {}): Promise<RoomRent> {
    const r = await this.post(`${this.config.gateway}/rent`, JSON.stringify({ room_ckb: Number(room) / 1e8, months }), this.token)
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? `the LSP answered ${r.status}`)
    // Kept before it is paid, so a page that stops right after paying still carries it. One left
    // unpaid moves for nothing: the LSP funds only paid room.
    const carried: { payment_hash: string; claim: string }[] = JSON.parse((await this.store.get(ROOM_RENT, SEALED)) ?? '[]')
    await this.store.set(ROOM_RENT, JSON.stringify([...carried, { payment_hash: body.payment_hash, claim: body.claim }]), SEALED)
    await this.pay(body.invoice)
    this.log(`Rent of ${ckb(room)} CKB of room paid (${String(body.payment_hash).slice(0, 10)}).`)
    const end = Date.now() + (opts.waitMs ?? 60_000)
    for (;;) {
      const now = await rentStatus(this.config.gateway, body.payment_hash).catch(() => null)
      if (now?.paid || Date.now() >= end) return { ...(now ?? (await rentStatus(this.config.gateway, body.payment_hash))), claim: body.claim }
      await sleep(2000)
    }
  }

  /** Move a rent to this tenant's node, with the claim its ask gave: a new channel after a close is
   * a new tenant, so a rent paid from the old channel follows to the new one. Do it after start and
   * before the opening. */
  async moveRent(paymentHash: string, claim: string): Promise<void> {
    const r = await this.post(`${this.config.gateway}/rent/${paymentHash}/move`, JSON.stringify({ claim }), this.token)
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? `the LSP answered ${r.status}`)
    this.log(`Rent ${paymentHash.slice(0, 10)} moved to this channel's node.`)
  }

  /** The rents an earlier channel here paid (rentRoom), moved to this tenant's node before it
   * opens, and kept while they run: a top-up within the month takes them along again. One that
   * ended, or that the gateway no longer moves (its ask lapsed unpaid), is let go; one the gateway
   * did not answer for stays for the next opening, which then gets the free room. */
  private async carryRents() {
    const carried: { payment_hash: string; claim: string }[] = JSON.parse((await this.store.get(ROOM_RENT, SEALED)) ?? '[]')
    if (!carried.length) return
    const kept: typeof carried = []
    for (const r of carried) {
      if ((await rentStatus(this.config.gateway, r.payment_hash).catch(() => null))?.ended) continue
      try {
        await this.moveRent(r.payment_hash, r.claim)
        kept.push(r)
      } catch (e) {
        this.log(`Rent ${r.payment_hash.slice(0, 10)} not moved: ${message(e)}`)
        if (!/does not move this rent|no such rental/.test(message(e))) kept.push(r)
      }
    }
    await this.store.set(ROOM_RENT, JSON.stringify(kept), SEALED)
  }

  /** An invoice for any amount, made when asked: for a host that is always there (a merchant's
   * purse), so nothing waits for an absent payee and any price works. Valid an hour unless told. */
  async invoice(amount: bigint, opts: { description?: string; validMs?: number } = {}): Promise<Sale> {
    await this.start()
    const c = this.state.channel
    if (!c?.ready) throw new Error('no ready channel to be paid into')
    if (this.state.feeDue > 0n) throw new Error(c.token ? 'pay the opening fee first' : `pay the opening fee (${ckb(this.state.feeDue)} CKB) first`)
    if (amount <= 0n) throw new Error('an invoice asks for something')
    if (amount > c.remote) throw new Error(c.token ? 'the channel can take less than that now' : `the channel can take ${ckb(c.remote)} CKB now, not ${ckb(amount)}`)
    // A payer is about to pay it: answer its signatures without the idle wait.
    this.stir(2 * 60_000)
    const valid = opts.validMs ?? 3_600_000
    const inv = await this.makeInvoice(amount, valid, false, opts.description ?? this.config.invoiceDescription)
    const sale: Sale = { paymentHash: inv.payment_hash, amount, invoice: inv.address, expiresAt: inv.expires_at ?? Date.now() + valid }
    const signing = this.config.link
    if (signing && this.linkKey && (await this.store.get(LINK_ON))) {
      sale.link = this.tenantId.slice(0, 12)
      const read = this.parseInvoice(inv.address)
      sale.sig = signing.sign(sale.link, inv.payment_hash as Hex, amount, read.expiry_ms ? read.timestamp_ms + read.expiry_ms : 0, this.linkKey as Hex)
    }
    return sale
  }

  /** The same payment as an invoice any Fiber node can pay. Released nodes (fnn 0.9, Fiber
   * Studio) cannot read this LSP's invoices: their trampoline hint is an attribute they do not
   * know ("invoice is invalid", 2026-10-31). The gateway has its receiving node make a plain one
   * for the same payment hash; paid there, the payment comes here through the LSP as any other,
   * so it ends as this invoice, paid (gateway /outside). Null where the gateway offers none. */
  async outsideInvoice(paymentHash: string): Promise<{ invoice: string; expiresAt: number } | null> {
    if (!this.token) throw new Error('no Fiber balance here to be paid into')
    // An outside payer may take a while to route it: answer its signatures without the idle wait.
    this.stir(2 * 60_000)
    const r = await this.post(`${this.config.gateway}/outside`, JSON.stringify({ payment_hash: paymentHash }), this.token)
    if (r.status === 404) return null
    const body = await r.json().catch(() => ({}))
    if (!r.ok || typeof body.invoice !== 'string' || typeof body.expires !== 'number') throw new Error(body.error ?? `the LSP answered ${r.status}`)
    return { invoice: body.invoice, expiresAt: body.expires * 1000 }
  }

  /** Called with each invoice's payment hash the moment its payment arrives and the signer
   * releases its secret: from then on the payment is this channel's. It may be called again for
   * the same hash after a restart (the release is repeated if it was not saved), so record once. */
  onPaid(fn: (paymentHash: string, amount: bigint) => void): () => void {
    this.paidListeners.add(fn)
    return () => this.paidListeners.delete(fn)
  }

  /** Whose channel this is: config.ownerKey of the funding wallet's lock hash, or null before one is
   * known. For a page that shows a channel only to the wallet that funded it (proof-of-self). */
  async owner(): Promise<string | null> {
    return (await this.store.get(OWNER)) ?? null
  }

  /** What came and went: payments sent from here and invoices paid to it, newest first, those of the
   * channels set aside too, and with no signer started here (none kept, only channels set aside):
   * the balance taken out, Activity said nothing of its Fiber payments (a tester's phone, 2026-10-30). */
  async history(): Promise<HistoryItem[]> {
    const rents: { payment_hash: string }[] = JSON.parse((await this.store.get(ROOM_RENT, SEALED).catch(() => undefined)) ?? '[]')
    const readInv = async (name: string): Promise<Invoice[]> => JSON.parse((await this.store.get(name, SEALED).catch(() => undefined)) ?? '[]')
    const kept = this.signer ? this.inv : await readInv(INVOICES)
    const seen = new Set(kept.map((i) => i.payment_hash))
    const old: Invoice[] = []
    for (const name of await this.store.names(`${INVOICES}-closed-`))
      for (const i of await readInv(name)) {
        if (seen.has(i.payment_hash)) continue
        seen.add(i.payment_hash)
        old.push(i)
      }
    return historyOf(await this.sentList(), [...old, ...kept], rents.map((r) => r.payment_hash), await this.tokensKept())
  }

  /** The channels of a token this host had, by id: their payments are in that token (historyOf). */
  private async tokenChannels(): Promise<Record<string, FiberScript>> {
    return Object.fromEntries(Object.entries(await this.tokensKept()).map(([id, t]) => [id, t.script]))
  }

  /** What this host keeps of each channel of a token it had (TokenKept), by channel id. */
  async tokensKept(): Promise<Record<string, TokenKept>> {
    const raw: Record<string, TokenKept | FiberScript> = JSON.parse((await this.store.get(TOKEN_CHANNELS).catch(() => undefined)) ?? '{}')
    return Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, 'script' in v ? v : { script: v, name: '', decimals: 8 }]))
  }

  /** What the gateway says now of the token of channel `id`, opened elsewhere or before its name was
   * kept: kept, told to the signer, and said by the channel. */
  private async learnToken(id: string, script: FiberScript) {
    const said = (await lspTerms(this.config.gateway)).tokens.find((t) => sameScript(t.script, script))
    if (!said) return
    const kept = await this.keepToken(id, said)
    await this.tellTokens()
    const c = this.state.channel
    if (c?.id === id) this.set({ channel: { ...c, unit: { name: kept.name, decimals: kept.decimals } } })
  }

  private async keepToken(id: string, t: Pick<TokenTerms, 'name' | 'script' | 'decimals' | 'cellDep' | 'linkMost'>): Promise<TokenKept> {
    const tokens = await this.tokensKept()
    const kept: TokenKept = { script: t.script, name: t.name, decimals: t.decimals, ...(t.cellDep ? { cellDep: t.cellDep } : {}), linkMost: t.linkMost }
    await this.store.set(TOKEN_CHANNELS, JSON.stringify({ ...tokens, [id]: kept }))
    return kept
  }

  /** Where the code of each token this host has a channel of is, and of `more`, as the signer's
   * setTokens takes it. */
  private async tokenCodes(more: Pick<TokenTerms, 'script' | 'cellDep'>[] = []): Promise<TokenCode[]> {
    const known = [...Object.values(await this.tokensKept()), ...more]
    const codes = new Map<string, TokenCode>()
    for (const t of known) if (t.cellDep) codes.set(`${t.script.code_hash.toLowerCase()}:${t.script.hash_type}`, { code_hash: t.script.code_hash, hash_type: t.script.hash_type, cell_dep: t.cellDep })
    return [...codes.values()]
  }

  /** Tell a signer (this host's, by default) where the code of each token this host has a channel of
   * is, and of `more`: it needs it for every transaction of such a channel, claims without the
   * gateway too, and checks it against the token's script itself. A signer before setTokens knows
   * RUSD alone: the one recovery() starts heard of no other, so a channel of tBEAF taken out read as
   * closed by force, and no claim of one could be made (2026-10-29). */
  private async tellTokens(more: Pick<TokenTerms, 'script' | 'cellDep'>[] = [], to: unknown = this.signer) {
    const signer = to as { setTokens?: (json: string) => Promise<string> } | null
    if (!signer?.setTokens) return
    const codes = await this.tokenCodes(more)
    if (!codes.length) return
    try {
      await signer.setTokens(JSON.stringify(codes))
    } catch (e) {
      this.log(`The signer did not take the tokens' code: ${message(e)}`)
    }
  }

  /** What this host knows of one of its invoices: released means paid to this channel. */
  invoiceState(paymentHash: string): { status: string; released: boolean } | undefined {
    const inv = this.inv.find((i) => i.payment_hash === paymentHash)
    return inv && { status: inv.status, released: !!inv.released }
  }

  /** The gateway's key for push subscriptions (Web Push, VAPID), or null when it sends none. */
  async pushKey(): Promise<string | null> {
    const r = await fetch(`${this.config.gateway}/push/key`)
    if (!r.ok) return null
    return ((await r.json()) as { key?: string }).key ?? null
  }

  /** Have the gateway tell this browser, through its push service, when a payment waits for this
   * tenant while its page is closed: the LSP keeps one for about a day, and a payee told in time
   * comes back for it. `subscription` is the browser's PushSubscription, as JSON. Returns how many
   * browsers are told about this tenant. */
  async pushSubscribe(subscription: { endpoint?: string; keys?: Record<string, string> }): Promise<number> {
    if (!this.token) throw new Error('no channel here to be told about')
    const r = await this.post(`${this.config.gateway}/push/subscribe`, JSON.stringify({ subscription }), this.token)
    const body = (await r.json().catch(() => ({}))) as { subscribed?: number; error?: string }
    if (!r.ok) throw new Error(body.error ?? `the gateway answered ${r.status}`)
    return body.subscribed ?? 0
  }

  /** Stop telling this browser (its push subscription's endpoint). */
  async pushUnsubscribe(endpoint: string): Promise<void> {
    if (!this.token) return
    await this.post(`${this.config.gateway}/push/unsubscribe`, JSON.stringify({ endpoint }), this.token)
  }

  /** Turn on this host's pay link, kept full while the host runs, and the key that signs its
   * invoices. Returns the link's id and that key's public half, to be published. */
  async openLink(): Promise<{ id: string; key: string }> {
    const signing = this.config.link
    if (!signing) throw new Error('this session has no pay link')
    await this.start()
    if (!this.state.channel?.ready) throw new Error(`open a channel first: ${this.config.item}s come into it`)
    if (!this.linkKey) {
      this.linkKey = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)))
      await this.store.set(LINK_KEY, this.linkKey, SEALED)
    }
    await this.store.set(LINK_ON, '1')
    this.linkChecked = 0
    const link = this.tenantId.slice(0, 12)
    const key = signing.publicKey(this.linkKey as Hex)
    this.set({ link, linkKey: key })
    return { id: link, key }
  }

  /** Payers waiting at the gateway for an amount this pay link keeps no invoice for (its live_ask):
   * one invoice of exactly that amount each, signed as the link's are, while the channel can take it
   * in. Each ask once; one the channel cannot take is left to the gateway's refusal. */
  private async answerAsks(asks: { id: string; amount: string }[]) {
    const c = this.state.channel
    const signing = this.config.link
    const linkKey = this.linkKey as Hex | null
    if (!signing || !linkKey || !c?.ready || c.token || this.away || !this.running || this.state.feeDue > 0n || !(await this.store.get(LINK_ON))) return
    for (const ask of asks) {
      if (this.asked.has(ask.id)) continue
      this.asked.add(ask.id)
      setTimeout(() => this.asked.delete(ask.id), 60_000)
      try {
        const amount = BigInt(ask.amount)
        if (amount <= 0n || amount > c.remote) continue
        const made = await this.makeInvoice(amount, LIVE_VALID)
        const read = this.parseInvoice(made.address)
        const ends = read.expiry_ms ? read.timestamp_ms + read.expiry_ms : 0
        const sig = signing.sign(this.tenantId.slice(0, 12), made.payment_hash as Hex, amount, ends, linkKey)
        const r = await this.post(`${this.config.gateway}/link/live`, JSON.stringify({ ask: ask.id, invoice: made.address, sig }), this.token)
        if (!r.ok) this.log(`Pay link: an invoice made on the spot was refused: ${(await r.json().catch(() => ({}))).error ?? r.status}`)
      } catch (e) {
        this.log(`Pay link: no invoice made on the spot: ${message(e)}`)
      }
    }
  }

  /** Keep two open invoices for each link amount the channel can still take, and give them to
   * the gateway. Not while payments arrive: making invoices holds up the signing. */
  private async refreshLink() {
    const c = this.state.channel
    const signing = this.config.link
    // Not while the opening fee is due: the gateway makes no invoice until it is paid. Not once the
    // page said bye, nor in the middle of a round it said bye in: a link put after the bye woke the
    // tenant at the LSP, and a payment then went to a signer that was gone (nightly, 2026-10-27).
    const left = () => this.away || !this.running
    // A pay link takes what the channel holds (since 2026-10-28): CKB, or its token.
    if (!signing || left() || !c?.ready || c.receiving || this.linkBusy || this.state.feeDue > 0n || Date.now() - this.linkChecked < (signing.everyMs ?? 60_000) || !(await this.store.get(LINK_ON))) return
    this.linkBusy = true
    let more = false
    try {
      const soon = Date.now() + DAY
      // In a token: each whole unit of it up to what its pay links offer, and its open bounds.
      const unit = c.token ? (await this.tokensKept())[c.id] : undefined
      const one = 10n ** BigInt(unit?.decimals ?? 8)
      const most = BigInt(unit?.linkMost ?? LINK_MOST)
      const amounts = c.token ? Array.from({ length: Number(most) }, (_, i) => BigInt(i + 1) * one) : signing.amounts
      const open = signing.open && c.token ? { each: signing.open.each, least: one / 100n > 0n ? one / 100n : 1n, most: most * one } : signing.open
      // Not the invoices made under the 7 day limit: a payment to one can still stop the channel.
      // This channel's only: a balance taken out and topped up in another token keeps none of the old.
      const offered = this.inv.filter((i) => i.link && i.channel_id === this.channelId && i.status === 'Open' && (i.expires_at ?? 0) > soon && (i.open ? !!open : amounts.includes(BigInt(i.amount))) && i.tlc_max !== undefined)
      let made = 0
      // The open invoices first: each serves any amount within its bounds.
      if (open && open.least <= c.remote)
        for (let n = offered.filter((i) => i.open).length; n < open.each && made < LINK_BATCH; n++) {
          if (left()) return
          offered.push(await this.makeOpenInvoice(open, LINK_VALID))
          made++
        }
      // One of each amount first, then the second, a batch per round: every amount is payable soon.
      for (let round = 1; round <= (signing.each ?? LINK_EACH) && made < LINK_BATCH; round++)
        for (const amount of amounts) {
          if (made >= LINK_BATCH) break
          if (amount > c.remote || offered.filter((i) => BigInt(i.amount) === amount).length >= round) continue
          if (left()) return
          offered.push(await this.makeInvoice(amount, LINK_VALID))
          made++
        }
      more = made >= LINK_BATCH
      // Each invoice goes with this host's signature of its hash, amount and end, the end read
      // from the invoice itself, as a payer reads it.
      const linkKey = this.linkKey as Hex | null
      if (!linkKey) throw new Error(`no key to sign the link with; accept ${this.config.item}s again`)
      const id = this.tenantId.slice(0, 12)
      if (this.linkSignedBy?.id !== id || this.linkSignedBy.key !== linkKey) {
        this.linkSigned.clear()
        this.linkSignedBy = { id, key: linkKey }
      }
      const signed: { invoice: string; sig: string }[] = []
      let fresh = 0
      for (const i of offered) {
        let entry = this.linkSigned.get(i.payment_hash)
        if (!entry || entry.invoice !== i.address) {
          const read = this.parseInvoice(i.address)
          const ends = read.expiry_ms ? read.timestamp_ms + read.expiry_ms : 0
          entry = { invoice: i.address, sig: signing.sign(id, i.payment_hash as Hex, BigInt(i.amount), ends, linkKey) }
          this.linkSigned.set(i.payment_hash, entry)
          // A round with many new ones (the first after opening) lets the page draw between them.
          if (++fresh % 4 === 0) await sleep(0)
        }
        signed.push(entry)
      }
      const kept = new Set(offered.map((i) => i.payment_hash))
      for (const h of [...this.linkSigned.keys()]) if (!kept.has(h)) this.linkSigned.delete(h)
      if (left()) return
      const r = await this.post(`${this.config.gateway}/link/put`, JSON.stringify({ invoices: signed }), this.token)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error)
      this.set({ link: body.link })
    } catch (e) {
      this.log(`Pay link: ${message(e)}`)
    } finally {
      // More to make: the next round comes in a few seconds instead of a minute.
      this.linkChecked = more ? Date.now() - 55_000 : Date.now()
      this.linkBusy = false
    }
  }
}
