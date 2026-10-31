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

import type { PoolNoteKind } from '@port0.sh/sdk'
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
  /** Per note script root, in the fee asset's smallest unit. The list endpoint
   * omits it; the single-pool endpoint carries it. */
  fee_schedule?: FeeScheduleEntry[]
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

/** Indexer status: the registry block it has read and its pool counts. */
export interface IndexerStatus {
  registry_id: string
  last_registry_block: number
  known_pools: number
  fetched_pools: number
  /** The indexer's own version, when it reports one. */
  version?: string
}

/** Reads the indexer's status, or null when it is unavailable. */
export async function fetchStatus(indexerUrl: string): Promise<IndexerStatus | null> {
  try {
    const response = await fetch(new URL('status', baseUrl(indexerUrl)))
    if (!response.ok) return null
    return (await response.json()) as IndexerStatus
  } catch {
    return null
  }
}

/** A pool of a legacy registry, read once by the indexer at startup. */
export interface LegacyPool {
  id: string
  registry_id: string
  token0: string
  token1: string
  token0_symbol: string
  token0_decimals: number
  token1_symbol: string
  token1_decimals: number
  reserve0: string
  reserve1: string
  lp_supply: string
  lp_fee_bps: number
  protocol_fee_share_bps: number
}

/** The pools of the legacy registries, as the indexer read them at startup. */
export async function fetchLegacyPools(indexerUrl: string): Promise<LegacyPool[]> {
  const response = await fetch(new URL('legacy', baseUrl(indexerUrl)))
  if (!response.ok) {
    throw new Error(`indexer /legacy returned ${response.status}`)
  }
  return (await response.json()) as LegacyPool[]
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

/** A transaction on an activity row: what it did and with how much, per token. */
export interface TradeDto {
  /** `swap`, `add`, `remove`, `collect`, or `other`. */
  kind: string
  tx_id: string
  /** Swap input per token, protocol fee included. */
  volume0: string
  volume1: string
  /** Reserves the transaction added. */
  in0: string
  in1: string
  /** Reserves it paid out. */
  out0: string
  out1: string
  /** False when the amounts were not recorded when the row was captured. */
  exact: boolean
  /** Pot a collect freed. */
  protocol_fee0: string
  protocol_fee1: string
}

/** One row of the pool's activity: a price observation or a transaction. */
/** The price a transaction traded at, as a ratio of base-unit amounts. */
export interface ActivityPrice {
  /** Token1 base units. */
  num: string
  /** Token0 base units. */
  den: string
}

/** One row of the pool's activity table: a transaction and its price. */
export interface ActivityRow {
  /** The block's timestamp, in seconds. */
  timestamp: number
  block: number
  /** Token1 per token0, from the transaction's own amounts. */
  price?: ActivityPrice
  trade: TradeDto
}

/** The chart's buckets and the table's rows, from one request. */
export interface PoolActivity {
  samples: IndexerSnapshot[]
  activity: ActivityRow[]
  /** Recorded transactions the table leaves out because they carry no amounts. */
  unrecorded: number
}

/**
 * Fetches the pool's activity in one request: the buckets to draw and the rows
 * to list, with each transaction already priced from the last observation at or
 * before its block.
 */
export async function fetchPoolActivity(
  indexerUrl: string,
  poolId: string,
  resolution: HistoryResolution,
  limit = 24,
): Promise<PoolActivity> {
  const url = new URL(
    `pools/${encodeURIComponent(normalizeHex(poolId))}/activity`,
    baseUrl(indexerUrl),
  )
  url.searchParams.set('resolution', resolution)
  url.searchParams.set('limit', String(limit))
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`indexer /pools/${poolId}/activity returned ${response.status}`)
  }
  return (await response.json()) as PoolActivity
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
    const { noteScript, POOL_NOTE_KINDS } = await import('@port0.sh/sdk')
    const schedule = new Map(
      (pool.fee_schedule ?? []).map((entry) => [entry.root.toLowerCase(), entry.amount]),
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
