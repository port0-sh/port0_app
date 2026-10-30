/**
 * Protocol totals, counted in the chain's fee asset.
 *
 * A leg is counted only when its token is worth the fee asset by identity: the
 * fee asset itself, or a dollar-pegged stablecoin listed by faucet id. Every
 * counted leg is taken at par, converted from its own decimals to the fee
 * asset's.
 *
 * Nothing is valued through a price inferred from another pool. That inference
 * is what let a pool holding 0.59 MICO against 2 USDCX price MICO at 3.38, and a
 * test token with a half-million supply turn five pools holding about 47 USDCX
 * into a TVL of 3.87M.
 *
 * A pool's own ratio makes its two legs equal in value: `reserve0` of token0 is
 * worth `reserve1` of token1 by construction. So a pool with one counted leg is
 * counted twice, and a pool with two counted legs once each. The error is bounded
 * by the counted leg itself: a skewed pool overstates by at most its dollar side,
 * where a price taken from elsewhere overstated by five orders of magnitude.
 *
 * Volume counts the counted legs only. A flow is not a stock, and the dollar side
 * is what the fee is charged on.
 */

/** The fields the totals read: the indexer's string-encoded amounts. */
export interface FeeAssetPool {
  id: string
  token0: string
  token1: string
  reserve0: string
  reserve1: string
  token0_decimals: number | null
  token1_decimals: number | null
  volume_24h_0: string
  volume_24h_1: string
}

export interface FeeAssetTotals {
  /** Liquidity in the fee asset's base units, over every counted leg. */
  tvlBase: bigint
  /** 24 h volume in the fee asset's base units. */
  volumeBase: bigint
  /** Pools with at least one counted leg. */
  counted: number
  /** Pools with no counted leg, and therefore no contribution. */
  excluded: number
}

/** One pool side, as far as valuation is concerned. */
interface Leg {
  token: string
  amount: bigint
  volume: bigint
  decimals: number | null
}

function legsOf(pool: FeeAssetPool): [Leg, Leg] {
  return [
    {
      token: pool.token0.toLowerCase(),
      amount: BigInt(pool.reserve0),
      volume: BigInt(pool.volume_24h_0),
      decimals: pool.token0_decimals,
    },
    {
      token: pool.token1.toLowerCase(),
      amount: BigInt(pool.reserve1),
      volume: BigInt(pool.volume_24h_1),
      decimals: pool.token1_decimals,
    },
  ]
}

/** A leg's amount in the fee asset's base units, at par. */
function atPar(amount: bigint, decimals: number | null, feeDecimals: number): bigint {
  if (decimals === null || decimals === feeDecimals) return amount
  const shift = feeDecimals - decimals
  return shift >= 0 ? amount * 10n ** BigInt(shift) : amount / 10n ** BigInt(-shift)
}

export interface PoolVolume {
  /** 24 h volume of the counted legs, in the fee asset's base units. */
  base: bigint
  /** Whether any leg is denominated in an asset counted at par. */
  counted: boolean
}

/**
 * A per-pool 24 h volume valuer, with the trusted set built once.
 *
 * The same rule as the protocol totals: a leg counts only when its token is
 * worth the fee asset by identity, and nothing is valued through a pool's own
 * ratio or another pool's price. A pool with no counted leg reports
 * `counted: false`, so a caller shows "—" instead of a false zero.
 */
export function volumeValuer(
  trustedTokens: readonly string[],
  feeDecimals: number,
): (pool: FeeAssetPool) => PoolVolume {
  const trusted = new Set(trustedTokens.map((id) => id.toLowerCase()))
  return (pool) => {
    let base = 0n
    let counted = false
    for (const leg of legsOf(pool)) {
      if (!trusted.has(leg.token)) continue
      counted = true
      base += atPar(leg.volume, leg.decimals, feeDecimals)
    }
    return { base, counted }
  }
}

/** Totals over the legs denominated in an asset counted at par. */
export function feeAssetTotals(
  pools: readonly FeeAssetPool[],
  trustedTokens: readonly string[],
  feeDecimals: number,
): FeeAssetTotals {
  const trusted = new Set(trustedTokens.map((id) => id.toLowerCase()))
  let tvlBase = 0n
  let volumeBase = 0n
  let counted = 0
  let excluded = 0
  for (const pool of pools) {
    const counted0: bigint[] = []
    for (const leg of legsOf(pool)) {
      if (!trusted.has(leg.token)) continue
      counted0.push(atPar(leg.amount, leg.decimals, feeDecimals))
      volumeBase += atPar(leg.volume, leg.decimals, feeDecimals)
    }
    if (counted0.length === 0) {
      excluded += 1
      continue
    }
    counted += 1
    const countedValue = counted0.reduce((sum, value) => sum + value, 0n)
    // One counted leg: the pool's ratio says the other is worth the same.
    tvlBase += counted0.length === 1 ? countedValue * 2n : countedValue
  }
  return { tvlBase, volumeBase, counted, excluded }
}
