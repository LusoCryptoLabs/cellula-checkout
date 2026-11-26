// The channel's commitment delay, and what it pulls along with it.
//
// After a close, each side's share waits this long on chain. That wait is also the time a person
// has to stop an LSP that publishes an old state while their page is closed: the longer, the
// safer, and the longer every close takes. Fiber ties payments to it (fiber-lib). With w, two thirds of the delay:
// - a channel opens only if each side's tlc_expiry_delta is at least w (fee.rs,
//   check_tlc_delta_with_epochs, called on open and on accept in network.rs);
// - a payment held for a person who is away closes the channel by force once its expiry is
//   within w (channel.rs, get_expired_offered_tlcs), so the time to come back for it is the
//   invoice's final expiry delta less w.
// - a payment this wallet sends is failed back by the LSP when it arrives within w (plus Fiber's
//   one minute check) of its expiry (channel.rs, ExpiryTooSoon). A payment to an ordinary
//   invoice, a day's final expiry and nothing else, arrives with at least a day and Fiber's
//   smallest random addition, 4 hours (graph.rs, rand_tlc_expiry_delta).
// A longer delay therefore asks for a longer final expiry, or the time to come back shrinks to
// nothing: with a day's final expiry, 9 epochs would close the channel on every held payment.
// Here the time to come back is kept whatever the delay, and the final expiry grows with it.
// And the delay stops where paying an ordinary invoice would fail: 10 epochs, though Fiber
// itself takes up to 84.

const DAY = 86_400_000
/** Fiber's measure of an epoch (config.rs, MILLI_SECONDS_PER_EPOCH). */
export const EPOCH_MS = 4 * 60 * 60 * 1000
/** Fiber's least (channel.rs, MIN_COMMITMENT_DELAY_EPOCHS). */
export const MIN_DELAY_EPOCHS = 1
/** Fiber's most (channel.rs, MAX_COMMITMENT_DELAY_EPOCHS); this wallet stops at MAX_DELAY_EPOCHS. */
export const FIBER_MAX_DELAY_EPOCHS = 84
/** A node's tlc_expiry_delta when nothing sets it (config.rs, DEFAULT_TLC_EXPIRY_DELTA). */
const FIBER_TLC_EXPIRY_DELTA = 4 * 60 * 60 * 1000

/** Two thirds of a delay of `epochs`, as Fiber computes it (channel.rs, tlc_expiry_delay). */
const window = (epochs: number) => Math.floor((epochs * EPOCH_MS * 2) / 3)

/** The least time left on a payment to an ordinary invoice when it reaches the LSP: a day's final
 * expiry and Fiber's smallest random addition (graph.rs, rand_tlc_expiry_delta). */
export const ORDINARY_PAYMENT_MS = DAY + FIBER_TLC_EXPIRY_DELTA
/** How often Fiber looks for TLCs too near their expiry (network.rs, CHECK_CHANNELS_INTERVAL). */
const CHECK_MS = 60_000
/** The longest delay at which the LSP still takes this wallet's payment to an ordinary invoice. */
export const MAX_DELAY_EPOCHS = (() => {
  let epochs = MIN_DELAY_EPOCHS
  while (epochs < FIBER_MAX_DELAY_EPOCHS && window(epochs + 1) + CHECK_MS < ORDINARY_PAYMENT_MS) epochs++
  return epochs
})()

/** The time a person has to come back for a payment held while they are away: what a day's final
 * expiry left with one epoch (about 21 hours), kept the same at every delay. */
export const COME_BACK_MS = DAY - window(1)

export type ChannelDelay = {
  epochs: number
  /** `commitment_delay_epoch` for open_channel: whole epochs, as Fiber's EpochNumberWithFraction. */
  field: string
  /** Two thirds of the delay: how close to its expiry a held payment closes the channel. */
  windowMs: number
  /** The final expiry delta of this wallet's invoices: the time to come back, plus the window. */
  finalExpiryMs: number
  /** `tlc_expiry_delta` for open_channel, when Fiber's default would be refused (more than one
   * epoch); the LSP must accept the channel with one at least as long (its own setting). */
  tlcExpiryDelta?: string
  /** How long a share waits on chain after a close. */
  closeMs: number
}

export function channelDelay(epochs = MIN_DELAY_EPOCHS): ChannelDelay {
  if (!Number.isInteger(epochs) || epochs < MIN_DELAY_EPOCHS || epochs > MAX_DELAY_EPOCHS) {
    throw new Error(`a channel's delay is a whole number of epochs from ${MIN_DELAY_EPOCHS} to ${MAX_DELAY_EPOCHS}, not ${epochs}: past ${MAX_DELAY_EPOCHS}, the LSP would refuse this wallet's payments to ordinary invoices`)
  }
  const windowMs = window(epochs)
  const finalExpiryMs = COME_BACK_MS + windowMs
  return {
    epochs,
    // EpochNumberWithFraction: number in the low 24 bits, index 0, length 1 from bit 40.
    field: '0x' + (0x10000000000 + epochs).toString(16),
    windowMs,
    finalExpiryMs,
    ...(windowMs > FIBER_TLC_EXPIRY_DELTA ? { tlcExpiryDelta: '0x' + windowMs.toString(16) } : {}),
    closeMs: epochs * EPOCH_MS,
  }
}
