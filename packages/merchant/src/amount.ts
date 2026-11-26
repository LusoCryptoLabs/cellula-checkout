// CKB amounts as people write them ("5", "0.37") and as the chain counts them (shannons, 10^-8 CKB).

import { MerchantError } from './errors.ts'

export const SHANNONS = 100_000_000n

/** "5" or 0.37 to shannons. Up to 8 decimals; anything else is refused rather than rounded. */
export function shannonsOf(ckb: string | number): bigint {
  const s = typeof ckb === 'number' ? (Number.isFinite(ckb) ? String(ckb) : '') : String(ckb ?? '').trim()
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new MerchantError('invalid_amount', `amount_ckb must be a CKB amount with up to 8 decimals, not "${String(ckb)}"`, 400)
  const [whole = '0', frac = ''] = s.split('.')
  return BigInt(whole) * SHANNONS + BigInt(frac.padEnd(8, '0'))
}

/** Shannons to the shortest CKB string: 500000000n is "5", 37000000n is "0.37". */
export function ckbOf(shannons: bigint): string {
  const whole = shannons / SHANNONS
  const frac = shannons % SHANNONS
  return frac ? `${whole}.${frac.toString().padStart(8, '0').replace(/0+$/, '')}` : `${whole}`
}
