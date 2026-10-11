import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LP_FEE_BPS,
  LP_FEE_TIERS_BPS,
} from './fees'


describe('LP fee tiers', () => {
  it('are the three Uniswap tiers', () => {
    expect(LP_FEE_TIERS_BPS).toEqual([5n, 30n, 100n])
    expect(DEFAULT_LP_FEE_BPS).toBe(30n)
  })
})
