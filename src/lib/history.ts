/**
 * Pool history arithmetic.
 *
 * A price is a ratio of two reserves whose raw values may exceed the safe
 * integer range, so it is computed in bigint and carried as a value scaled by
 * 10^PRICE_DIGITS. `formatScaled` renders it; the chart converts it to Number
 * for geometry only.
 */

import type { IndexerSnapshot } from './indexer'

/** Price display precision, in decimal digits. */
export const PRICE_DIGITS = 6

export interface HistoryPoint {
  sample: IndexerSnapshot
  /** Price of one token0 in token1, scaled by 10^PRICE_DIGITS. */
  priceScaled: bigint
}

/**
 * Price of one token0 in token1 for one sample, scaled by 10^PRICE_DIGITS.
 * Returns null when either reserve is zero: an empty pool has no price.
 */
export function priceScaled(
  sample: Pick<IndexerSnapshot, 'reserve0' | 'reserve1'>,
  token0Decimals: number,
  token1Decimals: number,
): bigint | null {
  const reserve0 = BigInt(sample.reserve0)
  const reserve1 = BigInt(sample.reserve1)
  if (reserve0 === 0n || reserve1 === 0n) return null
  const numerator = reserve1 * 10n ** BigInt(token0Decimals) * 10n ** BigInt(PRICE_DIGITS)
  const denominator = reserve0 * 10n ** BigInt(token1Decimals)
  return numerator / denominator
}

/** The samples that have a defined price, in the order given. */
export function historyPoints(
  samples: readonly IndexerSnapshot[],
  token0Decimals: number,
  token1Decimals: number,
): HistoryPoint[] {
  const points: HistoryPoint[] = []
  for (const sample of samples) {
    const scaled = priceScaled(sample, token0Decimals, token1Decimals)
    if (scaled !== null) points.push({ sample, priceScaled: scaled })
  }
  return points
}

/** Formats a value scaled by 10^digits, trimming trailing fraction zeros. */
export function formatScaled(scaled: bigint, digits = PRICE_DIGITS): string {
  const scale = 10n ** BigInt(digits)
  const whole = scaled / scale
  const fraction = (scaled % scale).toString().padStart(digits, '0').replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
}

/** The scaled price as a Number, for chart geometry only. */
export function scaledToNumber(scaled: bigint, digits = PRICE_DIGITS): number {
  return Number(scaled) / 10 ** digits
}

/**
 * UNIX seconds for a sample. A pool that has never been operated on keeps
 * `block_timestamp_last = 0`, so a zero timestamp falls back to the poll time.
 */
export function sampleTime(sample: Pick<IndexerSnapshot, 'timestamp' | 'polled_at'>): number {
  return sample.timestamp > 0 ? sample.timestamp : sample.polled_at
}

/** One candle: the price of one token0 in token1 across one history bucket. */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
}

/** The price of one token0 in token1 for a reserve pair, or null when it has none. */
function priceOf(
  reserve0: string,
  reserve1: string,
  token0Decimals: number,
  token1Decimals: number,
): number | null {
  const scaled = priceScaled({ reserve0, reserve1 }, token0Decimals, token1Decimals)
  return scaled === null ? null : scaledToNumber(scaled)
}

/**
 * Candles in ascending time order. Each sample carries the state at the end of
 * its bucket plus the bucket's opening state and its price extremes, so the
 * body is the move within the bucket and the wicks are the extremes it touched.
 *
 * The time axis is the sample time, not the block time of the last state change:
 * an idle pool keeps one block timestamp across every bucket, so a chart keyed
 * on it would collapse to a single candle. The table shows the block time; this
 * shows when the bucket was sampled.
 *
 * A chart library requires `high >= max(open, close)` and `low <= min(open,
 * close)`; the buckets are built to satisfy that, and the clamp here keeps it
 * true for a sample whose extremes are missing.
 */
export function candles(
  samples: readonly IndexerSnapshot[],
  token0Decimals: number,
  token1Decimals: number,
): Candle[] {
  const built: Candle[] = []
  for (const sample of samples) {
    const close = priceOf(sample.reserve0, sample.reserve1, token0Decimals, token1Decimals)
    if (close === null) continue
    const open =
      priceOf(sample.open_reserve0, sample.open_reserve1, token0Decimals, token1Decimals) ?? close
    const high =
      priceOf(sample.high_reserve0, sample.high_reserve1, token0Decimals, token1Decimals) ?? close
    const low =
      priceOf(sample.low_reserve0, sample.low_reserve1, token0Decimals, token1Decimals) ?? close
    const candle: Candle = {
      time: sample.polled_at,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
    }
    const last = built[built.length - 1]
    if (last === undefined || candle.time > last.time) {
      built.push(candle)
    } else if (candle.time === last.time) {
      // Two buckets cannot share a sample time, but a backfilled pair can.
      built[built.length - 1] = candle
    }
    // A time below the previous one is a backfilled sample; drop it.
  }
  return built
}
