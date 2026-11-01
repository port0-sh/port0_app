import { formatAmount } from './format'

/**
 * The deploy consume's fee, in the fee asset's base units, at verification base
 * fee 7. The funding note carries exactly this amount.
 */
export const POOL_DEPLOY_FEE_BASE_UNITS = 140n

/**
 * The faucet deploy consume's fee, in base units, at verification base fee 7:
 * 25,239 cycles. A faucet has no sweep, so the funding is exactly this.
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
