import { formatAmount } from './format'

/**
 * The price the network charges for the pool's deploy consume, in base units.
 *
 * Measured by `note_fee_benchmark` at verification base fee 7: 26,768 cycles, a
 * kernel fee of 105 and a pricer price of 112. The account is funded at the
 * price; a later collect sweeps any remainder toward the protocol.
 */
export const POOL_DEPLOY_FEE_BASE_UNITS = 112n

/**
 * Measured fee for the deploy consume of a network faucet, in base units.
 *
 * The same call shape as a pool deploy, but a lighter account: 25,239 cycles,
 * priced at 112 base units. A faucet has no sweep, so it is funded with exactly
 * this rather than with the pool's figure; the launch that follows is paid by the
 * owner's sponsorship.
 */
export const FAUCET_DEPLOY_FEE_BASE_UNITS = 112n

/**
 * Pool fee model.
 *
 * LP fee tiers follow Uniswap: 5, 30, and 100 basis points. The protocol fee
 * rate is not derived from the LP fee: the pool registry holds one rate and its
 * `register` procedure rejects a pool built with any other, so the create page
 * reads the rate from the registry instead of computing one.
 */

export const LP_FEE_TIERS_BPS = [5n, 30n, 100n] as const

export const DEFAULT_LP_FEE_BPS = 30n

/** Seconds in the one-day window every fee APR is stated over. */
export const FEE_APR_WINDOW_SECS = 86_400

/**
 * The launch cost sentence: the registry's register price, the balance the pool
 * needs for its first fee, and their total, in the fee asset.
 */
export function launchCostLine(
  registerFee: bigint,
  networkFee: bigint,
  decimals: number,
  symbol: string,
): string {
  const amount = (base: bigint): string => `${formatAmount(base, decimals)} ${symbol}`
  return (
    `Registry fee: ${amount(registerFee)} + ` +
    `network fee: ${amount(networkFee)} = ${amount(registerFee + networkFee)}`
  )
}

/**
 * Fee APR on a one-day basis.
 *
 * The indexer annualises over the pool's age until it reaches 24 h, so a young
 * pool reports an APR from a few minutes of fees. Scaling by the window converts
 * that to the rate a full day at the observed fee flow implies, so every pool's
 * APR reads on the same 24 h window and no short window is ever shown.
 */
export function feeAprOneDay(feeApr: number, windowSeconds: number): number {
  if (!(windowSeconds > 0) || !Number.isFinite(feeApr)) return 0
  return feeApr * (Math.min(windowSeconds, FEE_APR_WINDOW_SECS) / FEE_APR_WINDOW_SECS)
}
