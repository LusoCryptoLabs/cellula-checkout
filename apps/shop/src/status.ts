// What the page is told of the shop (GET /api/status): open, getting ready, or closed for now. The
// page asks again every few seconds while it is getting ready (public/shop.js).

import type { MerchantStatus } from '../../../packages/merchant/src/merchant.ts'

export type ShopStatus = Partial<MerchantStatus> & { ready: boolean; starting: boolean; error?: string }

/** `merchant`: null until startMerchant has returned; `startError`: why it did not start. */
export function shopStatus(merchant: { status(): MerchantStatus; waitsForFee(): boolean } | null, startError: string): ShopStatus {
  if (!merchant) return { ready: false, starting: !startError, error: startError || undefined }
  const s = merchant.status()
  // Its channel open and the LSP's opening fee not paid yet: the merchant pays it, and again a minute
  // after a failure, so the shop is still getting ready, not closed.
  return { ...s, starting: !s.ready && merchant.waitsForFee() }
}
