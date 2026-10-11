import { describe, expect, it } from 'vitest'
import { candles, formatScaled, historyPoints, priceScaled, sampleTime, scaledToNumber } from './history'
import type { IndexerSnapshot } from './indexer'

/** A sample with every field the price path reads. */
function sample(reserve0: string, reserve1: string): IndexerSnapshot {
  return {
    block: 1,
    timestamp: 1,
    polled_at: 1,
    reserve0,
    reserve1,
    open_reserve0: reserve0,
    open_reserve1: reserve1,
    high_reserve0: reserve0,
    high_reserve1: reserve1,
    low_reserve0: reserve0,
    low_reserve1: reserve1,
    lp_supply: '0',
    k: '0',
    pot0: '0',
    pot1: '0',
    price0_cumulative: '0',
    price1_cumulative: '0',
  }
}

/** A candle-bearing sample: reserves of 1 token0 against `prices[1]` at close. */
function bucket(
  timestamp: number,
  open: string,
  high: string,
  low: string,
  close: string,
): IndexerSnapshot {
  return {
    ...sample('1', close),
    timestamp,
    polled_at: timestamp,
    open_reserve0: '1',
    open_reserve1: open,
    high_reserve0: '1',
    high_reserve1: high,
    low_reserve0: '1',
    low_reserve1: low,
  }
}

describe('priceScaled', () => {
  it('returns null when either reserve is zero', () => {
    expect(priceScaled(sample('0', '5000000'), 4, 4)).toBeNull()
    expect(priceScaled(sample('5000000', '0'), 4, 4)).toBeNull()
  })

  it('is 0.5 when both tokens have the same decimals', () => {
    // 1.0 token0 (4 decimals) buys 0.5 token1 (4 decimals).
    expect(priceScaled(sample('1000000', '500000'), 4, 4)).toBe(500000n)
  })

  it('scales by the decimal difference', () => {
    // One whole token0 with 6 decimals, priced at two token1 units with 2.
    expect(priceScaled(sample('1000000', '200'), 6, 2)).toBe(2000000n)
  })

  it('stays exact past the safe integer range', () => {
    // A 30-digit reserve halved exactly; a Number-based ratio would not.
    expect(priceScaled(sample('123456789012345678901234567890', '61728394506172839450617283945'), 0, 0)).toBe(
      500000n,
    )
  })

  it('truncates below the display precision', () => {
    expect(priceScaled(sample('100000000000000000000', '1'), 0, 0)).toBe(0n)
  })
})

describe('historyPoints', () => {
  it('keeps only priced samples, in order', () => {
    const points = historyPoints(
      [sample('0', '0'), sample('1000000', '500000'), sample('1000000', '1000000')],
      4,
      4,
    )
    expect(points.map((point) => point.priceScaled)).toEqual([500000n, 1000000n])
  })
})

describe('formatScaled', () => {
  it('trims fraction zeros and drops a zero fraction', () => {
    expect(formatScaled(500000n)).toBe('0.5')
    expect(formatScaled(1000000n)).toBe('1')
    expect(formatScaled(0n)).toBe('0')
  })

  it('pads a short fraction', () => {
    expect(formatScaled(1n)).toBe('0.000001')
  })

  it('keeps a repeating fraction at the display precision', () => {
    expect(formatScaled(333333n)).toBe('0.333333')
  })

  it('renders a price above one', () => {
    expect(formatScaled(12500000n)).toBe('12.5')
  })
})

describe('scaledToNumber', () => {
  it('inverts the scale', () => {
    expect(scaledToNumber(500000n)).toBe(0.5)
    expect(scaledToNumber(12500000n)).toBe(12.5)
  })
})

describe('sampleTime', () => {
  it('prefers the block timestamp', () => {
    expect(sampleTime({ timestamp: 100, polled_at: 200 })).toBe(100)
  })

  it('falls back to the poll time when the pool has never changed', () => {
    expect(sampleTime({ timestamp: 0, polled_at: 200 })).toBe(200)
  })
})

describe('candles', () => {
  it('carries the bucket open, extremes, and close', () => {
    expect(candles([bucket(10, '2', '5', '1', '3')], 0, 0)).toEqual([
      { time: 10, open: 2, high: 5, low: 1, close: 3 },
    ])
  })

  it('builds candles from reserves, so the decimals scale every price', () => {
    // 100 whole token0 against 50 whole token1, both with two decimals.
    const point = { ...bucket(10, '5000', '5000', '5000', '5000'), reserve0: '10000' }
    expect(candles([point], 2, 2)[0].close).toBe(0.5)
  })

  it('clamps extremes around the body', () => {
    // An inverted high/low (1 and 5 against a body of 2 to 3) must not draw a
    // candle whose wick is inside its body.
    const candle = candles([bucket(10, '2', '1', '5', '3')], 0, 0)[0]
    expect(candle.high).toBe(3)
    expect(candle.low).toBe(2)
  })

  it('skips a sample without a price', () => {
    expect(candles([sample('0', '0')], 4, 4)).toEqual([])
  })

  it('keeps the newer candle for a repeated timestamp', () => {
    const built = candles([bucket(10, '1', '1', '1', '1'), bucket(10, '9', '9', '9', '9')], 0, 0)
    expect(built).toEqual([{ time: 10, open: 9, high: 9, low: 9, close: 9 }])
  })

  it('drops an out-of-order timestamp', () => {
    const built = candles([bucket(20, '1', '1', '1', '1'), bucket(10, '2', '2', '2', '2')], 0, 0)
    expect(built.map((candle) => candle.time)).toEqual([20])
  })

  it('places an idle bucket at its sample time, not the last state change', () => {
    // A pool that has not traded keeps one block timestamp across buckets.
    const idle = { ...bucket(1791591842, '1', '1', '1', '4'), polled_at: 1791591900 }
    expect(candles([idle], 0, 0)[0].time).toBe(1791591900)
  })
})
