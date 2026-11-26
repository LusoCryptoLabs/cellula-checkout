// Kept apart from session.ts so node's tests can load it: session.ts is not plain enough for type
// stripping.
/** Whether an opening was never funded, from the LSP's list of this tenant's channels (closed ones
 * included) while no opening is under way here. A funded channel stays in that list for good,
 * closed or not, but for one whose funding never reached the chain (fundingStranded); an opening the
 * wallet never signed waits there for the signature, then the LSP drops it (after five minutes). */
export function neverFunded(listed: { state: { state_name: string; state_flags?: string } } | undefined, opening: boolean): boolean {
  if (opening) return false
  if (!listed) return true
  return listed.state.state_name === 'NegotiatingFunding' && /AWAITING_EXTERNAL_FUNDING/.test(listed.state.state_flags ?? '')
}

/** A cell as CKB names it in a transaction's inputs. */
export type CellPoint = { tx_hash: string; index: string }

/** The cell a node rejected a transaction for, from its reason ("Resolve failed
 * Unknown(OutPoint(0x<hash><index, 4 bytes little endian>))"), or null. */
export function rejectedFor(reason: string | null | undefined): CellPoint | null {
  const m = /OutPoint\(0x([0-9a-f]{64})([0-9a-f]{8})\)/i.exec(reason ?? '')
  if (!m) return null
  return { tx_hash: '0x' + m[1]!.toLowerCase(), index: '0x' + parseInt(m[2]!.match(/../g)!.reverse().join(''), 16).toString(16) }
}

const ON_ITS_WAY = new Set(['pending', 'proposed', 'committed'])

/** Whether a funding the wallet signed can never reach the chain: it is neither committed nor on its
 * way (pending, proposed), and a cell it spends, made by a committed transaction, is spent already,
 * so by another. `inputs`: the cells it spends as the wallet signed it; the cell a node rejected it
 * for is added. Read again at the end, as a funding committed meanwhile spent them itself. Null when
 * the chain cannot say. Seen on LSP2, 2026-10-28 22:57: the LSP's watchtower took, as a settlement's
 * fee, an LSP cell that a funding the wallet had just signed spent too. The funding was rejected, the
 * LSP dropped the channel, and the page waited for it for good and refused to top up again. */
export async function fundingStranded(
  funding: string,
  inputs: CellPoint[],
  call: (method: string, params: unknown[]) => Promise<any>,
): Promise<boolean | null> {
  try {
    const status = async (): Promise<{ status?: string; reason?: string | null } | undefined> => (await call('get_transaction', [funding]))?.tx_status
    const first = await status()
    if (!first?.status) return null
    if (ON_ITS_WAY.has(first.status)) return false
    const cells = [...inputs]
    const rejected = rejectedFor(first.reason)
    if (rejected) cells.push(rejected)
    let spent = false
    for (const cell of cells) {
      const live = (await call('get_live_cell', [cell, false]))?.status
      if (!live || live === 'live') continue
      // A cell not live is spent, or not made yet: only one its transaction made is spent.
      if ((await call('get_transaction', [cell.tx_hash]))?.tx_status?.status === 'committed') {
        spent = true
        break
      }
    }
    if (!spent) return false
    const last = await status()
    return !!last?.status && !ON_ITS_WAY.has(last.status)
  } catch {
    return null
  }
}

/** Whether an opening needs this page no more: both sides signed the funding and the LSP sent it,
 * so the channel becomes ready without the page. Seen on testnet, 2026-10-09: the page signed the
 * two updates asked of it in the second the funding was submitted, was left at this state, and on
 * coming back three minutes later found the channel ready, having signed nothing more. */
export function pageNoLongerNeeded(stateName: string): boolean {
  return stateName === 'AwaitingChannelReady'
}

/** Whether a cooperative close needs this page no more: the page signed the closing and the LSP
 * sent it, and waits for the chain. Seen on testnet, 2026-10-09: left one second after Take out,
 * once the page had signed, the CKB was back in the wallet 36 s later with the page closed; left
 * before that signature, nothing moved until the page came back and signed it. */
export function closeNoLongerNeedsPage(stateName: string, flags: string): boolean {
  return stateName === 'ShuttingDown' && /WAITING_COMMITMENT_CONFIRMATION/.test(flags)
}

/** Waits until no payment is under way in the channel, as `read` sees it, for at most `ms`: a close
 * started while one is would wait for its sign-off for good. Seen on testnet, 2026-10-12: a take-back
 * started 3 s after paying stayed ShuttingDown, the payment taken by the LSP and not signed off,
 * until the LSP's close before its expiry, eleven days on. Throws if it is still under way. */
export async function waitSettled(
  read: () => Promise<{ going: bigint; receiving: boolean } | null>,
  ms = 60_000,
  every = 2_000,
): Promise<void> {
  for (const end = Date.now() + ms; ; ) {
    const c = await read()
    if (!c || (c.going === 0n && !c.receiving)) return
    if (Date.now() >= end) throw new Error('a payment is still settling in it; try again in a minute')
    await new Promise((r) => setTimeout(r, every))
  }
}

/** A TLC whose removal both sides have confirmed is done, though the LSP may list it a while: fnn
 * drops a failed one only at the channel's next commitment (`clean_up_failed_tlcs`), so an idle
 * channel keeps it listed. Seen on testnet, 2026-10-12: failed payments, `RemoveAckConfirmed`, held
 * every take-back of the channels they were made in. */
export function removalConfirmed(status: Record<string, string> | undefined): boolean {
  return !!status && Object.values(status).includes('RemoveAckConfirmed')
}

/** What is under way in a channel, from the LSP's list of its TLCs: paid out and not settled yet,
 * and whether a payment is coming in. Done ones are left out (`removalConfirmed`). */
export function inFlight(pending: { amount?: string; status?: Record<string, string> }[]): { going: bigint; receiving: boolean } {
  const live = pending.filter((t) => !!t.status && !removalConfirmed(t.status))
  return {
    going: live.filter((t) => 'Outbound' in t.status!).reduce((sum, t) => sum + BigInt(t.amount ?? '0x0'), 0n),
    receiving: live.some((t) => 'Inbound' in t.status!),
  }
}

/** The payment hashes of the payments coming in, in lower case, from the same list: what a round
 * asks the LSP about while they arrive. Null when one coming in has no hash to tell it by. */
export function comingIn(pending: { payment_hash?: string; status?: Record<string, string> }[]): Set<string> | null {
  const live = pending.filter((t) => !!t.status && 'Inbound' in t.status && !removalConfirmed(t.status))
  if (live.some((t) => !t.payment_hash)) return null
  return new Set(live.map((t) => t.payment_hash!.toLowerCase()))
}

/** What of this side's balance is paid though the LSP still lists it: the TLCs going out of the
 * payments whose payee's secret is here (`paid`, their hashes in lower case). fnn takes a paid TLC's
 * amount out of `local_balance` only as it drops the TLC from the list, once both sides signed its
 * removal (`remove_tlc_with_reason`), seconds after the secret came back. */
export function paidOut(pending: { amount?: string; payment_hash?: string; status?: Record<string, string> }[], paid: Set<string>): bigint {
  return pending
    .filter((t) => !!t.status && 'Outbound' in t.status && !!t.payment_hash && paid.has(t.payment_hash.toLowerCase()))
    .reduce((sum, t) => sum + BigInt(t.amount ?? '0x0'), 0n)
}

/** How long an opening waits in place before it gives up: the gateway lets 5 openings to the LSP at
 * once, and at the 100 tenant test (2026-10-12) the queue moved about one place every 12 s. */
export const TURN_STALL_MS = 15 * 60_000

/** Where an opening waiting its turn stands. `places`: each place the gateway gave it ("busy: N
 * ahead"), oldest first, a new entry only when the place changed. The minutes are measured from how
 * fast this queue moved so far, never assumed, so none until the place first moves. A queue that
 * moves is waited for however long it is (it gave up at 30 minutes before 2026-10-23); one whose
 * place has not moved for TURN_STALL_MS is `stalled`. */
export function turnWait(places: { at: number; ahead: number }[], now: number): { ahead: number; minutes: number | null; stalled: boolean } {
  const first = places[0]!
  const last = places[places.length - 1]!
  const moved = first.ahead - last.ahead
  const perPlace = moved > 0 ? (last.at - first.at) / moved : null
  return {
    ahead: last.ahead,
    minutes: perPlace === null ? null : Math.max(1, Math.ceil((last.ahead * perPlace) / 60_000)),
    stalled: now - last.at > TURN_STALL_MS,
  }
}

// The gateway's refusal of an opening past the most channels a wallet may have open at the LSP
// (the gateway's WALLET_CAP, since 2026-10-27), as its text reaches the page
// through the signer: "wallet_cap: this wallet has 2 Fiber balances open here, ...", and
// "wallet_cap_unknown: ..." when the LSP could not say how many are.
const WALLET_CAP_OPEN = /wallet_cap: this wallet has (\d+) Fiber balances? open/

/** How many channels the gateway said a wallet has open, from its refusal of one more; null for
 * any other error. */
export function walletCapOpen(message: string): number | null {
  const m = WALLET_CAP_OPEN.exec(message)
  return m ? Number(m[1]) : null
}

/** What an opening that failed at the LSP calls for, from its error and the try it was: try again,
 * or tell the person why. `turn`: the gateway said how many were ahead and the wait ran out.
 * `no-room`: the LSP's own side was not funded. `not-built`: the LSP could not build the channel
 * from the wallet's coins, too few free (said at once when the LSP says so: seen 2026-10-13, an
 * opening from a wallet whose coins another opening held got the builder's raw error after three
 * tries). `busy`: the LSP stopped it for taking too long. `wallet-cap`: the wallet has the most
 * channels open it may have, and `wallet-cap-unknown`: the LSP could not say how many, both said at
 * once, as asking again opens nothing. `raw`: none of these; its own words. */
export function openingFailure(message: string, attempt: number, turn: boolean): 'retry' | 'no-room' | 'not-built' | 'busy' | 'wallet-cap' | 'wallet-cap-unknown' | 'raw' {
  if (/wallet_cap_unknown/.test(message)) return 'wallet-cap-unknown'
  if (/wallet_cap:/.test(message)) return 'wallet-cap'
  if (/AbortFunding|Funding failed/.test(message)) return 'no-room'
  // In the builder's words too, as the LSP says them now (fnn 15923388, ckb-sdk 5.1.0: "capacity not
  // enough: `can not create change cell, ...`"). Taken for a passing error, it was tried twice more, 30 s
  // each on an opening the LSP had already given up, then called busy.
  if (/CapacityNotEnough|capacity not enough|need more capacity/i.test(message)) return 'not-built'
  if (!turn && attempt < 3) return 'retry'
  const interrupted = /tenant opening interrupted/.test(message)
  if (turn || (interrupted && /timeout/.test(message))) return 'busy'
  return interrupted ? 'not-built' : 'raw'
}

/** What a wallet holding `free` (shannons, its lock's plain cells) lacks to fund an opening of
 * `put` and get its change back: a CKB for the fee, and a change cell of its lock, which holds at
 * least its own size (`keep` bytes, one CKB a byte). 0 when it has enough. Seen on testnet,
 * 2026-10-22: a wallet holding 200 CKB put 139 in and the LSP could not build it, 60.99998 left
 * for a change cell of 63; the coins stayed held until the LSP dropped the opening five minutes on. */
export function fundingShort(free: bigint, put: bigint, keep: number): bigint {
  const need = put + 100_000_000n + BigInt(keep) * 100_000_000n
  return free < need ? need - free : 0n
}

/** What a channel is funded with, in whole CKB: what it spends, the LSP's opening fee on top of it
 * (in shannons, rounded up to a CKB; on top since 2026-10-23, so the person spends
 * what they chose), and the reserve. */
export function fundingPut(spend: bigint, openingFee: bigint, reserveCkb: bigint): bigint {
  return spend + (openingFee + 99_999_999n) / 100_000_000n + reserveCkb
}

/** A funding wallet as the LSP's gateway names it (the gateway's `funding_wallet`, the lock of the
 * funding's first input), to ask what an opening from it owes. */
export function walletKey(lock: { codeHash: string; hashType: string; args: string }): string {
  return `${lock.codeHash}:${lock.hashType}:${lock.args}`
}
