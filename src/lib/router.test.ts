import { describe, expect, it } from 'vitest'

import type { IndexerPool } from './indexer'
import { bestRoute, findRoutes, minInputForOneOut, quoteHop, reachableTokens, routeTokens, routerPools, tokenPrices, type RouterPool } from './router'

const A = '0xaaa'
const B = '0xbbb'
const C = '0xccc'
const D = '0xddd'
const E = '0xeee'

function pool(
  poolId: string,
  token0: string,
  token1: string,
  reserve0: bigint,
  reserve1: bigint,
  lpFeeBps = 30n,
): RouterPool {
  return { poolId, token0, token1, reserve0, reserve1, lpFeeBps }
}

describe('quoteHop', () => {
  it('matches the contract amount_out formula', () => {
    // in_with_fee = 10_000 * 9970; out = 99_700_000 * 1_000_000 / (1_000_000 * 10_000 + 99_700_000)
    const hop = quoteHop(pool('p', A, B, 1_000_000n, 1_000_000n), A, 10_000n)
    expect(hop?.amountOut).toBe(9871n)
  })

  it('quotes the reverse direction from the same reserves', () => {
    const hop = quoteHop(pool('p', A, B, 1_000_000n, 2_000_000n), B, 10_000n)
    expect(hop?.tokenOut).toBe(A)
    expect(hop?.reserveIn).toBe(2_000_000n)
    expect(hop?.reserveOut).toBe(1_000_000n)
    // Half the output token, so about half the out of the forward quote.
    expect(hop?.amountOut).toBe(4960n)
  })

  it('returns null for an unknown token, an empty pool, or a zero output', () => {
    expect(quoteHop(pool('p', A, B, 1_000_000n, 1_000_000n), C, 10_000n)).toBeNull()
    expect(quoteHop(pool('p', A, B, 0n, 1_000_000n), A, 10_000n)).toBeNull()
    // One base unit in against a huge output reserve still rounds to zero.
    expect(quoteHop(pool('p', A, B, 1_000_000n, 1n), A, 1n)).toBeNull()
  })
})

describe('findRoutes', () => {
  // The direct pool's C side is thin, so the two deep hops pay far more.
  const direct = pool('direct', A, C, 1_000_000n, 100_000n)
  const ab = pool('ab', A, B, 1_000_000n, 1_000_000n)
  const bc = pool('bc', B, C, 1_000_000n, 1_000_000n)

  it('picks the better of a direct and a two-hop route', () => {
    const routes = findRoutes([direct, ab, bc], A, C, 10_000n)
    expect(routes).toHaveLength(2)
    expect(routes[0].hops.map((hop) => hop.poolId)).toEqual(['ab', 'bc'])
    expect(routes[0].amountOut).toBeGreaterThan(routes[1].amountOut)
  })

  it('drops a route whose hop rounds to zero', () => {
    const thin = pool('thin', A, C, 1_000_000n, 100n)
    const routes = findRoutes([thin, ab, bc], A, C, 10_000n)
    expect(routes.map((route) => route.hops.length)).toEqual([2])
  })

  it('finds a three-hop route and respects maxHops', () => {
    const cd = pool('cd', C, D, 1_000_000n, 1_000_000n)
    const pools = [ab, bc, cd]
    expect(findRoutes(pools, A, D, 10_000n)).toHaveLength(1)
    expect(findRoutes(pools, A, D, 10_000n)[0].hops).toHaveLength(3)
    expect(findRoutes(pools, A, D, 10_000n, 2)).toHaveLength(0)
  })

  it('never revisits a token, so a cycle is not a route', () => {
    // A -> B -> A -> B... would loop; the target D is absent, so no route.
    const ba = pool('ba', B, A, 1_000_000n, 1_000_000n)
    expect(findRoutes([ab, ba], A, D, 10_000n)).toHaveLength(0)
    expect(bestRoute([ab, ba], A, D, 10_000n)).toBeNull()
  })

  it('returns no route for the same token or a non-positive amount', () => {
    expect(findRoutes([ab], A, A, 10_000n)).toHaveLength(0)
    expect(findRoutes([ab], A, B, 0n)).toHaveLength(0)
  })

  it('reports the total cost against the spot ratio', () => {
    // A small swap in a deep pool costs the 30 bps LP fee plus a few bps of
    // price impact and integer rounding.
    const routes = findRoutes([ab], A, B, 1_000n)
    expect(routes[0].costBps).toBeGreaterThanOrEqual(30n)
    expect(routes[0].costBps).toBeLessThanOrEqual(60n)
  })

  it('sums the ideal output across hops for the cost base', () => {
    const routes = findRoutes([ab, bc], A, C, 10_000n)
    expect(routes[0].idealOut).toBe(10_000n)
    expect(routes[0].amountOut).toBeLessThan(routes[0].idealOut)
  })
})

describe('routerPools', () => {
  it('converts indexed pools to bigint fields and lowercases ids', () => {
    const indexed = [
      {
        id: '0xAA',
        token0: '0xBB',
        token1: '0xCC',
        reserve0: '1000',
        reserve1: '2000',
        lp_fee_bps: 5,
      },
    ] as unknown as IndexerPool[]
    expect(routerPools(indexed)).toEqual([
      {
        poolId: '0xaa',
        token0: '0xbb',
        token1: '0xcc',
        reserve0: 1000n,
        reserve1: 2000n,
        lpFeeBps: 5n,
      },
    ])
  })
})

describe('minInputForOneOut', () => {
  it('finds the smallest input paying one base unit', () => {
    const ab = pool('ab', A, B, 1_000_000n, 1_000_000n)
    expect(minInputForOneOut(ab, A, B)).toBe(2n)
    expect(quoteHop(ab, A, 1n)).toBeNull()
    expect(quoteHop(ab, A, 2n)?.amountOut).toBe(1n)
  })

  it('is zero for the wrong direction or a dust output side', () => {
    const ab = pool('ab', A, B, 1_000_000n, 1_000_000n)
    expect(minInputForOneOut(ab, A, C)).toBe(0n)
    expect(minInputForOneOut(pool('dust', A, B, 1_000_000n, 1n), A, B)).toBe(0n)
  })
})

describe('tokenPrices', () => {
  it('reads a direct pool ratio', () => {
    const direct = pool('direct', A, B, 1_000_000n, 2_000_000n)
    const prices = tokenPrices([direct], A)
    expect(prices.get(A)).toBe(1)
    expect(prices.get(B)).toBe(0.5)
  })

  it('multiplies the ratios along a path', () => {
    const ab = pool('ab', A, B, 1_000_000n, 1_000_000n)
    const bc = pool('bc', B, C, 1_000_000n, 4_000_000n)
    const prices = tokenPrices([ab, bc], A)
    expect(prices.get(B)).toBe(1)
    expect(prices.get(C)).toBe(0.25)
  })

  it('leaves unpriced tokens out and ignores empty pools', () => {
    const empty = pool('empty', A, D, 1_000_000n, 0n)
    const prices = tokenPrices([empty], A)
    expect(prices.has(D)).toBe(false)
    expect(prices.size).toBe(1)
  })
})

describe('reachableTokens', () => {
  const ab = pool('ab', A, B, 1_000_000n, 1_000_000n)
  const bc = pool('bc', B, C, 1_000_000n, 1_000_000n)
  const cd = pool('cd', C, D, 1_000_000n, 1_000_000n)

  it('walks the graph up to maxHops and excludes the start', () => {
    expect([...reachableTokens([ab, bc, cd], A)].sort()).toEqual([B, C, D])
    expect([...reachableTokens([ab, bc, cd], A, 1)].sort()).toEqual([B])
    expect([...reachableTokens([ab, bc, cd], A, 2)].sort()).toEqual([B, C])
  })

  it('excludes a pool with an empty side', () => {
    const empty = pool('empty', A, E, 1_000_000n, 0n)
    expect([...reachableTokens([empty], A)]).toEqual([])
  })

  it('is empty for an unknown token', () => {
    expect([...reachableTokens([ab], E)]).toEqual([])
  })
})

describe('bestRoute', () => {
  it('returns the first of the ranked routes', () => {
    const direct = pool('direct', A, C, 1_000_000n, 100_000n)
    const ab = pool('ab', A, B, 1_000_000n, 1_000_000n)
    const bc = pool('bc', B, C, 1_000_000n, 1_000_000n)
    const best = bestRoute([direct, ab, bc], A, C, 10_000n)
    expect(best?.hops.map((hop) => hop.poolId)).toEqual(['ab', 'bc'])
  })
})

describe('routeTokens', () => {
  it('lists one token per node, sharing the hop junctions', () => {
    const ab = pool('ab', A, B, 1_000_000n, 1_000_000n)
    const bc = pool('bc', B, C, 1_000_000n, 1_000_000n)
    const route = bestRoute([ab, bc], A, C, 10_000n)
    expect(route && routeTokens(route)).toEqual([A, B, C])
  })

  it('is the input and output for a single hop', () => {
    const direct = pool('direct', A, C, 1_000_000n, 1_000_000n)
    const route = bestRoute([direct], A, C, 10_000n)
    expect(route && routeTokens(route)).toEqual([A, C])
  })
})
