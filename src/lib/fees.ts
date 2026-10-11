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
