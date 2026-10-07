import { describe, expect, it } from 'vitest'
import {
  MAX_INITIAL_SUPPLY,
  normalizeSymbol,
  parseInitialSupply,
  validateDecimals,
  validateInitialSupply,
  validateSymbol,
} from './token'

describe('validateSymbol', () => {
  it('accepts 3-6 uppercase letter symbols', () => {
    expect(validateSymbol('MEME')).toBeNull()
    expect(validateSymbol('abc')).toBeNull()
    expect(validateSymbol('TOKEN')).toBeNull()
  })

  it('rejects wrong lengths', () => {
    expect(validateSymbol('AB')).toMatch(/at least/)
    expect(validateSymbol('ABCDEFG')).toMatch(/at most/)
  })

  it('rejects digits and other characters (0.17 protocol: letters only)', () => {
    expect(validateSymbol('AB1')).toMatch(/letters only/)
    expect(validateSymbol('AB-CD')).toMatch(/letters only/)
    expect(validateSymbol('A B')).toMatch(/letters only/)
  })
})

describe('normalizeSymbol', () => {
  it('uppercases and trims', () => {
    expect(normalizeSymbol(' meme ')).toBe('MEME')
  })
})

describe('validateDecimals', () => {
  it('accepts integers in [0, 8]', () => {
    expect(validateDecimals(0)).toBeNull()
    expect(validateDecimals(8)).toBeNull()
    expect(validateDecimals(4)).toBeNull()
  })

  it('rejects negatives, fractions, and values above 8', () => {
    expect(validateDecimals(-1)).toMatch(/at least/)
    expect(validateDecimals(9)).toMatch(/at most/)
    expect(validateDecimals(2.5)).toMatch(/at least/)
  })
})

describe('validateInitialSupply', () => {
  it('accepts token amounts within the raw-unit bound', () => {
    // 1,000,000 tokens at 4 decimals = 10^10 base units; well below 2^57
    expect(validateInitialSupply('1000000', 4)).toBeNull()
    expect(validateInitialSupply('1', 0)).toBeNull()
  })

  it('accepts amounts up to the XYK MAX_AMOUNT bound', () => {
    expect(validateInitialSupply('144115188075855872', 0)).toBeNull()
    expect(validateInitialSupply('144115188075855873', 0)).toMatch(/must not exceed/)
  })

  it('applies a caller-supplied bound', () => {
    expect(validateInitialSupply('1000000', 0, 2_000_000n)).toBeNull()
    expect(validateInitialSupply('3000000', 0, 2_000_000n)).toMatch(/must not exceed/)
  })

  it('rejects empty, zero, and negative input', () => {
    expect(validateInitialSupply('', 4)).toMatch(/required/)
    expect(validateInitialSupply('0', 4)).toMatch(/greater than 0/)
    expect(validateInitialSupply('-1', 4)).toMatch(/Invalid|invalid/)
  })

  it('rejects more fractional digits than decimals allow', () => {
    expect(validateInitialSupply('1.00001', 4)).toMatch(/exceeds/)
  })

  it('bounds mirror the XYK contract MAX_AMOUNT', () => {
    expect(MAX_INITIAL_SUPPLY).toBe(1n << 57n)
  })
})

describe('parseInitialSupply', () => {
  it('converts token units by decimals', () => {
    expect(parseInitialSupply('1000000', 4)).toBe(10_000_000_000n)
  })
})
