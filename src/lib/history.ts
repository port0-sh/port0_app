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
  return priceFromAmounts(sample.reserve1, sample.reserve0, token0Decimals, token1Decimals)
}

/**
 * Price of one token0 in token1 from two base-unit amounts, scaled by
 * 10^PRICE_DIGITS. Returns null when either amount is zero.
 *
 * The two tokens have their own decimals, so the numerator carries token0's
 * decimals and the denominator token1's: `num / 10^token1Decimals` is token1
 * units, `den / 10^token0Decimals` token0 units, and their ratio is the price.
 */
export function priceFromAmounts(
  num: string,
  den: string,
  token0Decimals: number,
  token1Decimals: number,
): bigint | null {
  const numeratorUnits = BigInt(num)
  const denominatorUnits = BigInt(den)
  if (numeratorUnits === 0n || denominatorUnits === 0n) return null
  const numerator = numeratorUnits * 10n ** BigInt(token0Decimals) * 10n ** BigInt(PRICE_DIGITS)
  const denominator = denominatorUnits * 10n ** BigInt(token1Decimals)
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

/**
 * How much time the chart actually covers: the span between the first and the
 * last observation, the same clock the candles are drawn on. A pool that has not
 * changed keeps one state time across every bucket, so the state time cannot
 * measure the window; the poll time can.
 */
export function sampleWindow(samples: readonly IndexerSnapshot[]): number | null {
  if (samples.length < 2) return null
  const first = samples[0].polled_at
  const last = samples[samples.length - 1].polled_at
  return last > first ? last - first : null
}

/** The window as words: minutes under an hour, hours under two days, then days. */
export function windowLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `Last ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 48) {
    return `Last ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  // Two days is the point where days read better than hours, so the plural is
  // the only form this branch can produce.
  return `Last ${Math.round(hours / 24)} days`
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
