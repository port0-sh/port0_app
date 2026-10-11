/**
 * Indexer client.
 *
 * The indexer is the application's pool source. It reads the on-chain registry
 * for the pool set and serves each pool's state, token metadata, and network
 * note fee schedule. There is no local pool list.
 *
 * Amounts arrive as decimal strings because u64 and u128 exceed the safe
 * integer range of JSON numbers.
 */

import type { PoolNoteKind } from 'miden-xyk-sdk'
import { normalizeHex, shortHex } from './format'

export interface FeeScheduleEntry {
  /** Note script root, lowercase hex. */
  root: string
  /** Fee amount, decimal string. */
  amount: string
}

export interface IndexerPool {
  id: string
  token0: string
  token1: string
  token0_symbol: string | null
  token0_decimals: number | null
  token1_symbol: string | null
  token1_decimals: number | null
  /** Faucet that denominates the network note fees. */
  fee_asset_id: string | null
  /** Per note script root, in the fee asset's smallest unit. */
  fee_schedule: FeeScheduleEntry[]
  reserve0: string
  reserve1: string
  lp_supply: string
  k: string
  spot_price: number
  pot0: string
  pot1: string
  lp_fee_bps: number
  protocol_fee_share_bps: number
  block: number
  first_seen_unix: number
  last_change_unix: number
  volume_24h_0: string
  volume_24h_1: string
  lp_fees_24h_0: string
  lp_fees_24h_1: string
  protocol_fees_24h_0: string
  protocol_fees_24h_1: string
  swaps_24h: number
  adds_24h: number
  removes_24h: number
  collects_24h: number
  /**
   * Annualised fee yield for liquidity providers, as a fraction: 0.124 is
   * 12.4%. Value-weighted across both reserves and annualised over
   * `fee_apr_window_secs`, which is the pool's age until it reaches 24 h.
   */
  fee_apr: number
  fee_apr_window_secs: number
}

/** The subset of a pool the pages need, with token metadata resolved. */
export interface PoolView {
  poolId: string
  token0FaucetId: string
  token1FaucetId: string
  token0Symbol: string
  token1Symbol: string
  token0Decimals: number
  token1Decimals: number
  /** Faucet that denominates the network note fees; empty when unset. */
  feeFaucetId: string
  noteFees: Partial<Record<PoolNoteKind, string>>
}

function baseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

/** One page of the pool list, with the cursor for the next one. */
export interface PoolPage {
  pools: IndexerPool[]
  nextCursor: string | null
}

/**
 * Fetches one page of indexed pools.
 *
 * The list is paginated by pool id: pass the previous page's `nextCursor` back
 * as `cursor`. `token` keeps only pools holding that faucet.
 */
export async function fetchPools(
  indexerUrl: string,
  options: { token?: string; cursor?: string | null; limit?: number } = {},
): Promise<PoolPage> {
  const url = new URL('pools', baseUrl(indexerUrl))
  if (options.token) url.searchParams.set('token', options.token)
  if (options.cursor) url.searchParams.set('cursor', options.cursor)
  if (options.limit) url.searchParams.set('limit', String(options.limit))
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`indexer /pools returned ${response.status}`)
  }
  const body = (await response.json()) as {
    pools: IndexerPool[]
    next_cursor?: string
  }
  return { pools: body.pools, nextCursor: body.next_cursor ?? null }
}

/** One history sample. Amounts are decimal strings; see the file header. */
export interface IndexerSnapshot {
  block: number
  timestamp: number
  polled_at: number
  /** State at the end of the bucket. */
  reserve0: string
  reserve1: string
  /** State at the bucket's first sample. */
  open_reserve0: string
  open_reserve1: string
  /** Reserves at the bucket's highest and lowest price. */
  high_reserve0: string
  high_reserve1: string
  low_reserve0: string
  low_reserve1: string
  lp_supply: string
  k: string
  pot0: string
  pot1: string
  price0_cumulative: string
  price1_cumulative: string
}

/** History resolutions the indexer serves. */
export type HistoryResolution = '1m' | '5m' | '1h' | '6h' | '1d'

/** Fetches one indexed pool, or null when unknown. */
export async function fetchPool(
  indexerUrl: string,
  poolId: string,
): Promise<IndexerPool | null> {
  const response = await fetch(
    new URL(`pools/${encodeURIComponent(normalizeHex(poolId))}`, baseUrl(indexerUrl)),
  )
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`indexer /pools/${poolId} returned ${response.status}`)
  }
  return (await response.json()) as IndexerPool
}

/**
 * Fetches the pool's sampled history. The indexer keeps 24 h and buckets it at
 * one sample per minute, five minutes, or one hour.
 */
export async function fetchPoolHistory(
  indexerUrl: string,
  poolId: string,
  resolution: HistoryResolution,
): Promise<IndexerSnapshot[]> {
  const url = new URL(
    `pools/${encodeURIComponent(normalizeHex(poolId))}/history`,
    baseUrl(indexerUrl),
  )
  url.searchParams.set('resolution', resolution)
  const response = await fetch(url)
  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`indexer /pools/${poolId}/history returned ${response.status}`)
  }
  return (await response.json()) as IndexerSnapshot[]
}

/**
 * Maps an indexed pool to a view, resolving the note fee schedule roots to
 * note kinds through the SDK's compiled note scripts.
 *
 * `includeNoteFees` is false for callers that do not show fees: the mapping is
 * the only reason this module needs the WASM SDK, and loading 3.7 MB of it to
 * read a symbol and a decimal count is not a trade worth making.
 */
export async function toPoolView(
  pool: IndexerPool,
  includeNoteFees = true,
): Promise<PoolView> {
  const noteFees: Partial<Record<PoolNoteKind, string>> = {}
  if (includeNoteFees) {
    const { noteScript, POOL_NOTE_KINDS } = await import('miden-xyk-sdk')
    const schedule = new Map(
      pool.fee_schedule.map((entry) => [entry.root.toLowerCase(), entry.amount]),
    )
    for (const kind of POOL_NOTE_KINDS) {
      const root = noteScript(kind).root().toHex().toLowerCase()
      const amount = schedule.get(root)
      if (amount !== undefined) {
        noteFees[kind] = amount
      }
    }
  }
  return {
    poolId: normalizeHex(pool.id),
    token0FaucetId: normalizeHex(pool.token0),
    token1FaucetId: normalizeHex(pool.token1),
    token0Symbol: pool.token0_symbol ?? shortHex(pool.token0),
    token1Symbol: pool.token1_symbol ?? shortHex(pool.token1),
    token0Decimals: pool.token0_decimals ?? 0,
    token1Decimals: pool.token1_decimals ?? 0,
    feeFaucetId: pool.fee_asset_id ? normalizeHex(pool.fee_asset_id) : '',
    noteFees,
  }
}
