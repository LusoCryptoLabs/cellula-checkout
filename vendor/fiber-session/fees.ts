// The most a payment from this channel may spend in routing fees, in shannons: 1% of the amount
// plus 0.01 CKB, the second part scaled down to 5% of the amount for payments under 0.2 CKB, so
// a small payment is never capped at several times what it pays (0.1 CKB was capped at 11%).
// The trial LSP charges 0.1% (tlc_fee_proportional_millionths 1000), well under this.
const FIXED = 1_000_000n // 0.01 CKB

/** In a token (`decimals` of its own): the same in its units, a hundredth of it for the fixed part,
 * and at least one of its smallest units, so a token of few decimals can pay any fee at all. */
export function feeCap(amount: bigint, decimals = 8): bigint {
  if (amount <= 0n) return 0n
  const fixed = decimals === 8 ? FIXED : decimals >= 2 ? 10n ** BigInt(decimals - 2) : 1n
  const scaled = amount / 20n
  const cap = amount / 100n + (scaled < fixed ? scaled : fixed)
  return decimals === 8 || cap > 0n ? cap : 1n
}
