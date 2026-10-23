/**
 * Multihop swap routing over the indexed pools.
 *
 * Pure bigint arithmetic with the pool's own `amount_out` formula, so the index
 * page can rank routes without loading the WASM client. Reserves are the
 * indexer's last snapshot, so a route is a quote, not a guarantee: execution
 * still passes a per-hop slippage bound.
 *
 * A route is a sequence of hops over distinct tokens. Two pools cannot serve
 * the same pair (the registry rejects a duplicate), so each hop has one pool.
 */

import type { IndexerPool } from './indexer'

/** Maximum number of hops a route may take. */
export const MAX_HOPS = 3

/** Basis-point denominator, mirroring the pool contract's `FEE_DENOMINATOR`. */
const FEE_DENOMINATOR = 10_000n

/** A pool as the router needs it: token pair, reserves, and LP fee tier. */
export interface RouterPool {
  poolId: string
  token0: string
  token1: string
  reserve0: bigint
  reserve1: bigint
  lpFeeBps: bigint
}

/** One swap on one pool. */
export interface RouteHop {
  poolId: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  /** Snapshot reserves the quote used, in the hop's direction. */
  reserveIn: bigint
  reserveOut: bigint
}

/** A complete route: the hops, the total out, and the total cost. */
export interface Route {
  hops: RouteHop[]
  amountIn: bigint
  amountOut: bigint
  /** Output at the snapshot's spot ratio with no fee. */
  idealOut: bigint
  /**
   * Total cost against the spot ratio, in basis points:
   * `(idealOut - amountOut) * 10000 / idealOut`. Covers the LP fees and the
   * price impact of every hop together.
   */
  costBps: bigint
}

/**
 * The route as one token per node: the first hop's input followed by every
 * hop's output. Adjacent hops share a token, so this is the shortest chain
 * that shows the whole path.
 */
export function routeTokens(route: Route): string[] {
  return [route.hops[0].tokenIn, ...route.hops.map((hop) => hop.tokenOut)]
}

/** Converts indexed pools to router pools. Amounts are decimal strings. */
export function routerPools(pools: readonly IndexerPool[]): RouterPool[] {
  return pools.map((pool) => ({
    poolId: pool.id.toLowerCase(),
    token0: pool.token0.toLowerCase(),
    token1: pool.token1.toLowerCase(),
    reserve0: BigInt(pool.reserve0),
    reserve1: BigInt(pool.reserve1),
    lpFeeBps: BigInt(pool.lp_fee_bps),
  }))
}

/**
 * Quotes one hop on one pool, or null when the pool does not hold `tokenIn`,
 * is empty, or the output rounds to zero.
 */
export function quoteHop(
  pool: RouterPool,
  tokenIn: string,
  amountIn: bigint,
): RouteHop | null {
  const from = tokenIn.toLowerCase()
  let tokenOut: string
  let reserveIn: bigint
  let reserveOut: bigint
  if (pool.token0 === from) {
    tokenOut = pool.token1
    reserveIn = pool.reserve0
    reserveOut = pool.reserve1
  } else if (pool.token1 === from) {
    tokenOut = pool.token0
    reserveIn = pool.reserve1
    reserveOut = pool.reserve0
  } else {
    return null
  }
  if (amountIn <= 0n || reserveIn === 0n || reserveOut === 0n) return null

  // The protocol fee is carved out of the LP fee, so it does not change the
  // output; this mirrors `amm/swap.rs::amount_out`.
  const weight = FEE_DENOMINATOR - pool.lpFeeBps
  const amountInWithFee = amountIn * weight
  const amountOut =
    (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee)
  if (amountOut === 0n) return null

  return {
    poolId: pool.poolId,
    tokenIn: from,
    tokenOut: tokenOut.toLowerCase(),
    amountIn,
    amountOut,
    reserveIn,
    reserveOut,
  }
}

/** Builds a route from its hops and computes the totals. */
function makeRoute(hops: RouteHop[]): Route {
  const amountIn = hops[0].amountIn
  const amountOut = hops[hops.length - 1].amountOut
  let numerator = amountIn
  let denominator = 1n
  for (const hop of hops) {
    numerator *= hop.reserveOut
    denominator *= hop.reserveIn
  }
  const idealOut = numerator / denominator
  const costBps = idealOut === 0n ? 0n : ((idealOut - amountOut) * FEE_DENOMINATOR) / idealOut
  return { hops, amountIn, amountOut, idealOut, costBps }
}

/**
 * Returns every route from `tokenIn` to `tokenOut` up to `maxHops`, best first.
 *
 * A route never visits a token twice, so the search terminates and a hop can be
 * undone. The indexer's pool set is small (hundreds), so the search is a plain
 * depth-first walk.
 */
export function findRoutes(
  pools: readonly RouterPool[],
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  maxHops: number = MAX_HOPS,
): Route[] {
  const from = tokenIn.toLowerCase()
  const target = tokenOut.toLowerCase()
  if (from === target || amountIn <= 0n || maxHops < 1) return []

  const routes: Route[] = []
  const visited = new Set<string>([from])

  const walk = (current: string, amount: bigint, hops: RouteHop[]): void => {
    for (const pool of pools) {
      const hop = quoteHop(pool, current, amount)
      if (!hop || visited.has(hop.tokenOut)) continue
      const next = [...hops, hop]
      if (hop.tokenOut === target) {
        routes.push(makeRoute(next))
        continue
      }
      if (next.length >= maxHops) continue
      visited.add(hop.tokenOut)
      walk(hop.tokenOut, hop.amountOut, next)
      visited.delete(hop.tokenOut)
    }
  }

  walk(from, amountIn, [])
  routes.sort((left, right) => {
    if (left.amountOut !== right.amountOut) return left.amountOut > right.amountOut ? -1 : 1
    return left.hops.length - right.hops.length
  })
  return routes
}

/** Returns the best route, or null when no path exists. */
export function bestRoute(
  pools: readonly RouterPool[],
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  maxHops: number = MAX_HOPS,
): Route | null {
  const routes = findRoutes(pools, tokenIn, tokenOut, amountIn, maxHops)
  return routes[0] ?? null
}

/**
 * Raw spot prices of every token in `numeraire`: numeraire base units per token
 * base unit, found by a breadth-first walk of the pool graph.
 *
 * Across one pool the rate is `reserveCurrent / reserveNext`, so a path of hops
 * multiplies the ratios. A token with no path is absent from the map. The values
 * are display estimates: they ignore fees, depth, and price impact.
 */
export function tokenPrices(
  pools: readonly RouterPool[],
  numeraire: string,
  maxHops: number = MAX_HOPS,
): Map<string, number> {
  const start = numeraire.toLowerCase()
  const prices = new Map<string, number>([[start, 1]])
  let frontier: string[] = [start]
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = []
    for (const token of frontier) {
      const price = prices.get(token)
      if (price === undefined) continue
      for (const pool of pools) {
        if (pool.reserve0 === 0n || pool.reserve1 === 0n) continue
        let other: string | null = null
        let reserveCurrent: bigint | null = null
        let reserveOther: bigint | null = null
        if (pool.token0 === token) {
          other = pool.token1
          reserveCurrent = pool.reserve0
          reserveOther = pool.reserve1
        } else if (pool.token1 === token) {
          other = pool.token0
          reserveCurrent = pool.reserve1
          reserveOther = pool.reserve0
        }
        if (other === null || reserveCurrent === null || reserveOther === null) continue
        if (prices.has(other)) continue
        prices.set(other, price * (Number(reserveCurrent) / Number(reserveOther)))
        next.push(other)
      }
    }
    frontier = next
  }
  return prices
}

/**
 * The smallest input whose swap pays at least one base unit of the output.
 *
 * Mirrors `amm/swap.rs`: solves
 * `in * (10000 - fee) * reserveOut / (reserveIn * 10000 + in * (10000 - fee)) >= 1`.
 * Returns zero when the pool is too shallow for any amount to pay a base unit,
 * or when the two tokens are not this pool's pair in that direction.
 */
export function minInputForOneOut(
  pool: RouterPool,
  tokenIn: string,
  tokenOut: string,
): bigint {
  const from = tokenIn.toLowerCase()
  const target = tokenOut.toLowerCase()
  let reserveIn: bigint
  let reserveOut: bigint
  if (pool.token0 === from && pool.token1 === target) {
    reserveIn = pool.reserve0
    reserveOut = pool.reserve1
  } else if (pool.token1 === from && pool.token0 === target) {
    reserveIn = pool.reserve1
    reserveOut = pool.reserve0
  } else {
    return 0n
  }
  if (reserveOut <= 1n || pool.lpFeeBps >= 10_000n) return 0n
  const numerator = reserveIn * FEE_DENOMINATOR
  const denominator = (reserveOut - 1n) * (FEE_DENOMINATOR - pool.lpFeeBps)
  return (numerator + denominator - 1n) / denominator
}

/**
 * The tokens reachable from `tokenIn` within `maxHops`, excluding `tokenIn`
 * itself.
 *
 * An edge exists only where a pool holds non-zero reserves on both sides: a
 * pool with an empty side pays nothing out, so it can carry neither the first
 * hop nor a later one. The search is amount-free, so a token quoted to zero at
 * a tiny amount still counts as routable.
 */
export function reachableTokens(
  pools: readonly RouterPool[],
  tokenIn: string,
  maxHops: number = MAX_HOPS,
): Set<string> {
  const from = tokenIn.toLowerCase()
  const seen = new Set<string>()
  let frontier: string[] = [from]
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = []
    for (const token of frontier) {
      for (const pool of pools) {
        if (pool.reserve0 === 0n || pool.reserve1 === 0n) continue
        const to = pool.token0 === token ? pool.token1 : pool.token1 === token ? pool.token0 : null
        if (to === null || to === from || seen.has(to)) continue
        seen.add(to)
        next.push(to)
      }
    }
    frontier = next
  }
  return seen
}
