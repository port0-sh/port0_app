import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatBps,
  normalizeHex,
  parseAmount,
  shortAddress,
  shortHex,
} from './format'

describe('normalizeHex', () => {
  it('strips 0x prefix and lowercases', () => {
    expect(normalizeHex('0xAB12')).toBe('ab12')
    expect(normalizeHex('  AB12 ')).toBe('ab12')
  })
})

describe('shortHex', () => {
  it('truncates long ids', () => {
    expect(shortHex('0x1234567890abcdef', 4, 4)).toBe('0x1234…cdef')
  })

  it('returns short ids whole', () => {
    expect(shortHex('0xabcd')).toBe('0xabcd')
  })
})

describe('shortAddress', () => {
  it('trims long bech32 addresses', () => {
    expect(shortAddress('mtst1qy3x7k9p2w8m5v6n4r2t8')).toBe('mtst1qy3x7…n4r2t8')
  })

  it('leaves short values whole', () => {
    expect(shortAddress('0xabcd')).toBe('0xabcd')
  })
})

describe('parseAmount', () => {
  it('parses integers', () => {
    expect(parseAmount('12', 8)).toBe(1_200_000_000n)
  })

  it('parses decimals with exact padding', () => {
    expect(parseAmount('1.5', 8)).toBe(150_000_000n)
    expect(parseAmount('0.00000001', 8)).toBe(1n)
  })

  it('parses zero', () => {
    expect(parseAmount('0', 8)).toBe(0n)
  })

  it('parses amounts with thousands separators', () => {
    expect(parseAmount('250,000', 0)).toBe(250_000n)
    expect(parseAmount('1,500.5', 1)).toBe(15_005n)
  })

  it('rejects malformed input', () => {
    expect(() => parseAmount('', 8)).toThrow(RangeError)
    expect(() => parseAmount('-1', 8)).toThrow(RangeError)
    expect(() => parseAmount('abc', 8)).toThrow(RangeError)
    expect(() => parseAmount('1.2.3', 8)).toThrow(RangeError)
  })

  it('rejects too many fractional digits', () => {
    expect(() => parseAmount('1.000000001', 8)).toThrow(RangeError)
  })

  it('rejects invalid decimals', () => {
    expect(() => parseAmount('1', -1)).toThrow(RangeError)
    expect(() => parseAmount('1', 19)).toThrow(RangeError)
    expect(() => parseAmount('1', 1.5)).toThrow(RangeError)
  })
})

describe('formatAmount', () => {
  it('groups integer digits', () => {
    expect(formatAmount(1234567890n, 8)).toBe('12.3456789')
    expect(formatAmount(1234567890123n, 0)).toBe('1,234,567,890,123')
  })

  it('trims trailing fractional zeros', () => {
    expect(formatAmount(1_500_000_000n, 8)).toBe('15')
    expect(formatAmount(1_000_000_000n, 9)).toBe('1')
  })

  it('formats zero', () => {
    expect(formatAmount(0n, 8)).toBe('0')
  })

  it('pads fractional digits to full precision when needed', () => {
    expect(formatAmount(123456789n, 8)).toBe('1.23456789')
  })
})

describe('formatBps', () => {
  it('formats basis points as a percentage', () => {
    expect(formatBps(0n)).toBe('0.00%')
    expect(formatBps(30n)).toBe('0.30%')
    expect(formatBps(100n)).toBe('1.00%')
    expect(formatBps(5000n)).toBe('50.00%')
  })
})
