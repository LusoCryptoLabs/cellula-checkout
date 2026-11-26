import { ccc } from '@ckb-ccc/core'

// A channel is funded by the person's own wallet: the LSP builds the funding transaction,
// freezes it, and hands it back unsigned. The wallet signs it once and the LSP takes it back
// with nothing changed but the witnesses. These helpers move it between Fiber's JSON-RPC shape
// and CCC's, and refuse to hand back a transaction a wallet altered on the way. First
// written for the cellula.id app.

type Hex = `0x${string}`
export type FiberScript = { code_hash: string; hash_type: string; args: string }
type FiberCellDep = { dep_type: 'code' | 'dep_group'; out_point: { tx_hash: Hex; index: Hex } }
export type FiberTransaction = {
  version: string
  cell_deps: FiberCellDep[]
  header_deps: string[]
  inputs: { previous_output: { tx_hash: string; index: string }; since: string }[]
  outputs: { capacity: string; lock: FiberScript; type?: FiberScript | null }[]
  outputs_data: string[]
  witnesses: string[]
}

export function toFiberScript(s: ccc.ScriptLike): FiberScript {
  const script = ccc.Script.from(s)
  return { code_hash: script.codeHash, hash_type: script.hashType, args: script.args }
}

const fromFiberScript = (s: FiberScript) => ccc.Script.from({ codeHash: s.code_hash, hashType: s.hash_type as ccc.HashTypeLike, args: s.args })

function depType(t: string): ccc.DepType {
  if (t === 'dep_group' || t === 'depGroup') return 'depGroup'
  if (t === 'code') return 'code'
  throw new Error(`unknown cell dep type ${t}`)
}

function toFiberCellDep(d: ccc.CellDepLike): FiberCellDep {
  const dep = ccc.CellDep.from(d)
  return {
    dep_type: dep.depType === 'depGroup' ? 'dep_group' : 'code',
    out_point: { tx_hash: dep.outPoint.txHash as Hex, index: ccc.numToHex(dep.outPoint.index) as Hex },
  }
}

/** A transaction's hash, which its signatures do not change. */
export function fiberTxHash(tx: FiberTransaction): string {
  return toCccTransaction(tx).hash()
}

function toCccTransaction(tx: FiberTransaction): ccc.Transaction {
  return ccc.Transaction.from({
    version: tx.version,
    cellDeps: tx.cell_deps.map((d) => ({ depType: depType(d.dep_type), outPoint: { txHash: d.out_point.tx_hash, index: d.out_point.index } })),
    headerDeps: tx.header_deps,
    inputs: tx.inputs.map((i) => ({ previousOutput: { txHash: i.previous_output.tx_hash, index: i.previous_output.index }, since: i.since })),
    outputs: tx.outputs.map((o) => ({ capacity: o.capacity, lock: fromFiberScript(o.lock), type: o.type ? fromFiberScript(o.type) : undefined })),
    outputsData: tx.outputs_data,
    witnesses: tx.witnesses,
  })
}

/**
 * A wallet whose lock Fiber does not know, a smart account for one, funds a channel by saying what
 * its lock needs: the cell deps a transaction spending it carries, and the length of the witness
 * lock field its signature fills. Fiber prices a 65-byte secp256k1 witness; the wallet's own room
 * is written before it signs, which leaves the transaction hash as it was.
 */
export type FundingLockInfo = { lock: ccc.ScriptLike; cellDeps: ccc.CellDepLike[]; witnessLockLen: number }
export interface FundsWithOwnLock {
  fundingLockInfo(): Promise<FundingLockInfo>
}
const ownLock = (s: ccc.Signer) => (typeof (s as Partial<FundsWithOwnLock>).fundingLockInfo === 'function' ? (s as unknown as FundsWithOwnLock) : null)

/** The 65-byte secp256k1 signature Fiber prices the funding witness for. */
const PRICED_LOCK_LEN = 65

/** The locks a channel can be funded from, and the wallets that sign them. */
const SIGNABLE: [ccc.KnownScript, ccc.SignerSignType][] = [
  [ccc.KnownScript.Secp256k1Blake160, ccc.SignerSignType.CkbSecp256k1],
  [ccc.KnownScript.JoyId, ccc.SignerSignType.JoyId],
]

async function knownLock(signer: ccc.Signer): Promise<{ lock: ccc.Script; known: ccc.KnownScript | null }> {
  const lock = ccc.Script.from((await signer.getRecommendedAddressObj()).script)
  for (const [known] of SIGNABLE) {
    const info = await signer.client.getKnownScript(known)
    if (info.codeHash === lock.codeHash && info.hashType === lock.hashType) return { lock, known }
  }
  return { lock, known: null }
}

/** Whether this wallet can fund a channel, and if not, why. Omnilock wallets (MetaMask and
 * others) are not proven yet: Fiber leaves a secp256k1-sized witness placeholder. */
export async function fundingSupport(signer: ccc.Signer): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (ownLock(signer)) return { ok: true }
  const { known } = await knownLock(signer)
  const pair = SIGNABLE.find(([k]) => k === known)
  if (!pair) return { ok: false, reason: 'This wallet cannot fund a Fiber channel yet. JoyID and plain CKB wallets can.' }
  if (signer.signType !== pair[1]) return { ok: false, reason: 'This wallet does not sign for the lock it holds its CKB under.' }
  return { ok: true }
}

/** The wallet's lock, and the cell deps the LSP needs to build a transaction spending it. */
export async function fundingLock(signer: ccc.Signer): Promise<{ lock: ccc.Script; cellDeps: FiberCellDep[] }> {
  const own = ownLock(signer)
  if (own) {
    const info = await own.fundingLockInfo()
    return { lock: ccc.Script.from(info.lock), cellDeps: info.cellDeps.map(toFiberCellDep) }
  }
  const { lock, known } = await knownLock(signer)
  if (!known) throw new Error('this wallet cannot fund a Fiber channel yet')
  const info = await signer.client.getKnownScript(known)
  return { lock, cellDeps: (await signer.client.getCellDeps(info.cellDeps)).map(toFiberCellDep) }
}

/** Fiber's least funding fee rate, shannons per KB, and the most an acceptor (fnn's
 * MAX_FUNDING_FEE_RATE) and the channel signer (lsp-signer policy.rs) take. */
export const FUNDING_FEE_RATE_LEAST = 1000n
export const FUNDING_FEE_RATE_MOST = 100_000n
/** Fiber prices the funding witness at 65 bytes, and a JoyID or smart-account witness is several
 * times that: such a funding asks this many times the rate, so what it pays per KB of its real
 * size still reaches it. 6000 shannons per KB let a JoyID funding of 1,231 bytes through at the
 * least rate (measured on testnet). */
const WIDE_WITNESS_TIMES = 6n

type Requestor = { request(method: string, params: unknown[]): Promise<unknown> }

/**
 * What the chain asks for a transaction now, in shannons per KB: the least its pool takes
 * (tx_pool_info) or the median of its recent blocks (get_fee_rate_statistics), whichever is more,
 * and never under Fiber's least. What the node does not say counts as the least. A funding at the
 * least rate waited 2 h 38 min in a testnet pool whose blocks paid 25 to 70 times it (2026-11-08).
 */
export async function poolFeeRate(client: ccc.Client): Promise<bigint> {
  const requestor = (client as { requestor?: Requestor }).requestor
  return poolFeeRateBy(async (method, params) => {
    // CCC's statistics say the least when the node has none (no transaction in recent blocks).
    if (method === 'get_fee_rate_statistics') return { median: ccc.numToHex((await client.getFeeRateStatistics()).median) }
    if (!requestor) throw new Error('not a JSON-RPC client')
    return requestor.request(method, params)
  })
}

/** poolFeeRate through a node's JSON-RPC `call` (the result of each method): for a session's own
 * CKB endpoint. */
export async function poolFeeRateBy(call: (method: string, params: unknown[]) => Promise<unknown>): Promise<bigint> {
  let median = 0n
  let least = 0n
  try {
    const statistics = (await call('get_fee_rate_statistics', [])) as { median?: string } | null
    if (statistics?.median) median = ccc.numFrom(statistics.median)
  } catch {
    // the least
  }
  try {
    const info = (await call('tx_pool_info', [])) as { min_fee_rate?: string } | null
    if (info?.min_fee_rate) least = ccc.numFrom(info.min_fee_rate)
  } catch {
    // the least
  }
  return [median, least].reduce((a, b) => (b > a ? b : a), FUNDING_FEE_RATE_LEAST)
}

/**
 * Give up a funding the wallet signed that is not on chain: the wallet spends one of its plain coins
 * the funding spends (`inputs`, as signed) back to its own lock, at what the pool asks, and while the
 * pool holds the funding at more than its `min_replace_fee` (CKB replaces a transaction only for a
 * higher fee), so the funding can never confirm. `call`: the node's JSON-RPC. Returns the hash sent.
 */
export async function giveUpFunding(
  wallet: ccc.Signer,
  funding: string,
  inputs: { tx_hash: string; index: string }[],
  call: (method: string, params: unknown[]) => Promise<any>,
): Promise<string> {
  const status = (await call('get_transaction', [funding]))?.tx_status
  if (status?.status === 'committed') throw new Error('Its funding is on chain: the channel opens, close it then.')
  const { lock } = await fundingLock(wallet)
  let input: { tx_hash: string; index: string } | undefined
  for (const point of inputs) {
    const cell = await wallet.client.getCell({ txHash: point.tx_hash, index: point.index })
    if (cell && cell.cellOutput.lock.eq(lock) && !cell.cellOutput.type && cell.outputData === '0x') {
      input = point
      break
    }
  }
  if (!input) throw new Error('None of the coins this funding spends is a plain one of this wallet.')
  const replace = status?.min_replace_fee ? BigInt(status.min_replace_fee) : 0n
  let rate = await poolFeeRateBy(call)
  let tx = ccc.Transaction.from({ inputs: [{ previousOutput: { txHash: input.tx_hash, index: input.index } }] })
  for (let round = 0; round < 3; round++) {
    tx = ccc.Transaction.from({ inputs: [{ previousOutput: { txHash: input.tx_hash, index: input.index } }] })
    await tx.completeFeeChangeToLock(wallet, lock, rate, undefined, { shouldAddInputs: false })
    if ((await tx.getFee(wallet.client)) > replace) break
    // Past the fee it must beat: priced on its own size, with a little more.
    rate = ((replace + 1n) * 1000n) / BigInt(tx.toBytes().length + 4) + 1000n
  }
  return wallet.sendTransaction(tx)
}

/** The fee rate of a cooperative close this side asks (session.ts, close): what the pool asks, at
 * most CLOSE_FEE_RATE_MOST, the channel signer's own bound (lsp-signer policy.rs). At 1,000 alone a
 * close waits in a full pool as the fundings of 2026-11-08 did. */
export const CLOSE_FEE_RATE_MOST = 100_000n
export async function closeFeeRateBy(call: (method: string, params: unknown[]) => Promise<unknown>): Promise<bigint> {
  const rate = await poolFeeRateBy(call)
  return rate < CLOSE_FEE_RATE_MOST ? rate : CLOSE_FEE_RATE_MOST
}

/**
 * The funding fee rate to ask for (hex, shannons per KB): what the pool asks now (poolFeeRate),
 * times WIDE_WITNESS_TIMES for a wallet whose witness Fiber prices too small, and at most
 * FUNDING_FEE_RATE_MOST, so a spike cannot burn a wallet and the LSP does not refuse it.
 */
export async function fundingFeeRate(signer: ccc.Signer): Promise<string> {
  const own = ownLock(signer)
  const wide = own ? (await own.fundingLockInfo()).witnessLockLen > PRICED_LOCK_LEN : signer.signType === ccc.SignerSignType.JoyId
  const rate = (await poolFeeRate(signer.client)) * (wide ? WIDE_WITNESS_TIMES : 1n)
  return ccc.numToHex(rate < FUNDING_FEE_RATE_MOST ? rate : FUNDING_FEE_RATE_MOST)
}

/** Whether a cell of the wallet is one the funding may spend or return: plain CKB, or for a channel
 * of `token`, a cell of that token holding its 16-byte amount and nothing else. */
function fundable(type: ccc.Script | undefined, data: ccc.Hex, token?: ccc.Script): boolean {
  if (!type) return data === '0x'
  return !!token && type.eq(token) && ccc.bytesFrom(data).length === 16
}

/** Sign the frozen funding transaction with the wallet. Its hash covers everything but the
 * witnesses, so if it moved, the wallet rebuilt something and the LSP would refuse it. A channel
 * of `token` is funded with cells of that token too; how many go in the signer checked already
 * (lsp-signer `FundingWallet`). */
export async function signFunding(unsigned: FiberTransaction, signer: ccc.Signer, tokenLike?: ccc.ScriptLike): Promise<FiberTransaction> {
  const support = await fundingSupport(signer)
  if (!support.ok) throw new Error(support.reason)
  const token = tokenLike ? ccc.Script.from(tokenLike) : undefined
  const tx = toCccTransaction(unsigned)
  const before = tx.hash()
  // Only plain CKB of the wallet funds a channel: a cell of its lock that carries a type or data (a
  // token, a name, a smart account's settings) is never signed away with it, but for the token of
  // a token channel.
  const { lock } = await fundingLock(signer)
  for (const input of tx.inputs) {
    const cell = await signer.client.getCell(input.previousOutput)
    if (!cell) throw new Error('a cell the funding spends is not on chain')
    if (cell.cellOutput.lock.eq(lock) && !fundable(cell.cellOutput.type, cell.outputData, token))
      throw new Error('the funding spends a cell of this wallet that is not plain CKB, so it is not signed')
  }
  // And its change comes back as plain CKB (or the channel's token): change of its lock under a
  // type, or holding data, is frozen or held to ransom by whoever controls that type, and no
  // wallet balance counts it.
  for (const [i, output] of tx.outputs.entries()) {
    if (output.lock.eq(lock) && !fundable(output.type, tx.outputsData[i] ?? '0x', token))
      throw new Error('the funding returns change to this wallet that is not plain CKB, so it is not signed')
  }
  const own = ownLock(signer)
  if (own) await tx.prepareSighashAllWitness(lock, (await own.fundingLockInfo()).witnessLockLen, signer.client)
  const signed = await signer.signOnlyTransaction(tx)
  if (signed.hash() !== before) throw new Error('the wallet changed the funding transaction while signing it, so the LSP would refuse it')
  return { ...unsigned, witnesses: signed.witnesses }
}

/** Sign a wallet's own cell in a claim on a closed channel (`FiberSession.recovery`). The
 * channel's signer signed the claim already, over everything but the cell deps and the witnesses,
 * so nothing else may move: the wallet may only add the deps of its own lock. Every cell beside the
 * channel's is plain CKB of this wallet. */
export async function signClaim(unsigned: FiberTransaction, signer: ccc.Signer): Promise<FiberTransaction> {
  const tx = toCccTransaction(unsigned)
  const signedPart = (t: ccc.Transaction) => {
    const c = t.clone()
    c.cellDeps = []
    return c.hash()
  }
  const before = signedPart(tx)
  // A copy of its own: CCC hands back the same transaction it was given, mutated (ccc.Transaction.from).
  const required = toCccTransaction(unsigned).cellDeps
  const lock = (await signer.getRecommendedAddressObj()).script
  for (const input of tx.inputs.slice(1)) {
    const cell = await signer.client.getCell(input.previousOutput)
    if (!cell || !cell.cellOutput.lock.eq(lock) || cell.cellOutput.type || cell.outputData !== '0x')
      throw new Error('the claim spends a cell that is not plain CKB of this wallet, so it is not signed')
  }
  const own = ownLock(signer)
  let prepared = tx
  if (own) await tx.prepareSighashAllWitness(lock, (await own.fundingLockInfo()).witnessLockLen, signer.client)
  else prepared = await signer.prepareTransaction(tx)
  const signed = await signer.signOnlyTransaction(prepared)
  const kept = required.every((d) => signed.cellDeps.some((e) => e.eq(d)))
  if (signedPart(signed) !== before || !kept) throw new Error('the wallet changed the claim while signing it, so the chain would refuse it')
  return { ...unsigned, cell_deps: signed.cellDeps.map(toFiberCellDep), witnesses: signed.witnesses }
}

/** 1_250_000_000n -> "12.5". */
export function ckb(n: bigint): string {
  const a = n < 0n ? -n : n
  const frac = (a % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  return `${n < 0n ? '-' : ''}${a / 100_000_000n}${frac ? `.${frac}` : ''}`
}
