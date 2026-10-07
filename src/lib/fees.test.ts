import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LP_FEE_BPS,
  LP_FEE_TIERS_BPS,
  protocolFeeBps,
  protocolFeeBpsDisplay,
} from './fees'

describe('protocolFeeBps', () => {
  it('is fixed per LP fee tier', () => {
    expect(protocolFeeBps(5n)).toBe(1n)
    expect(protocolFeeBps(30n)).toBe(2n)
    expect(protocolFeeBps(100n)).toBe(5n)
  })

  it('returns zero for unknown tiers', () => {
    expect(protocolFeeBps(42n)).toBe(0n)
  })
})

describe('protocolFeeBpsDisplay', () => {
  it('formats integer basis points', () => {
    expect(protocolFeeBpsDisplay(30n)).toBe('2 bps')
    expect(protocolFeeBpsDisplay(100n)).toBe('5 bps')
  })
})

describe('LP fee tiers', () => {
  it('are the three Uniswap tiers', () => {
    expect(LP_FEE_TIERS_BPS).toEqual([5n, 30n, 100n])
    expect(DEFAULT_LP_FEE_BPS).toBe(30n)
  })
})
