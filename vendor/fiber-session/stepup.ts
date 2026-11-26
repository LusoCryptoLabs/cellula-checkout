// When a payment from the quick balance asks for the passkey: each
// payment of the step-up amount or less needed only a tap, however many were made, so whoever held
// the unlocked phone could empty the balance a little at a time. Now the payments made without the
// passkey in the last QUIET_MS count together.

/** How long payments made without the passkey are counted together. */
export const QUIET_MS = 10 * 60_000

export type Quiet = { at: number; amount: bigint }[]

/** Whether this payment, with those made without the passkey lately, passes the step-up amount. */
export function needsPasskey(quiet: Quiet, amount: bigint, cap: bigint, now: number): boolean {
  const lately = quiet.filter((p) => now - p.at < QUIET_MS).reduce((s, p) => s + p.amount, 0n)
  return amount + lately > cap
}
