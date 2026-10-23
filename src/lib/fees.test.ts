import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LP_FEE_BPS,
  FEE_APR_WINDOW_SECS,
  LP_FEE_TIERS_BPS,
  feeAprOneDay,
} from './fees'


describe('LP fee tiers', () => {
  it('are the three Uniswap tiers', () => {
    expect(LP_FEE_TIERS_BPS).toEqual([5n, 30n, 100n])
    expect(DEFAULT_LP_FEE_BPS).toBe(30n)
  })
})

describe('feeAprOneDay', () => {
  it('leaves a 24-hour window unchanged', () => {
    expect(feeAprOneDay(0.2, FEE_APR_WINDOW_SECS)).toBeCloseTo(0.2)
    expect(feeAprOneDay(0.2, FEE_APR_WINDOW_SECS * 2)).toBeCloseTo(0.2)
  })

  it('scales a short window down to a day', () => {
    // 15 minutes of fees, annualised over that window, is 96x the day rate.
    expect(feeAprOneDay(9.6, 900)).toBeCloseTo(0.1)
    expect(feeAprOneDay(1.0, 4_320)).toBeCloseTo(0.05)
  })

  it('is zero for a missing window or a non-finite rate', () => {
    expect(feeAprOneDay(0.2, 0)).toBe(0)
    expect(feeAprOneDay(Number.NaN, 900)).toBe(0)
  })
})
