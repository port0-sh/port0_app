/**
 * Pool fee model.
 *
 * LP fee tiers follow Uniswap: 5, 30, and 100 basis points. The protocol fee
 * is a fixed value per tier, paid to the platform's fee recipient; it is not
 * derived from the LP fee.
 */

export const LP_FEE_TIERS_BPS = [5n, 30n, 100n] as const

export const DEFAULT_LP_FEE_BPS = 30n

/** Protocol fee (bps) for a given LP fee tier. */
export function protocolFeeBps(lpFeeBps: bigint): bigint {
  switch (lpFeeBps) {
    case 5n:
      return 1n
    case 30n:
      return 2n
    case 100n:
      return 5n
    default:
      return 0n
  }
}

/** Protocol fee as integer basis points: "2 bps". */
export function protocolFeeBpsDisplay(lpFeeBps: bigint): string {
  return `${protocolFeeBps(lpFeeBps)} bps`
}
