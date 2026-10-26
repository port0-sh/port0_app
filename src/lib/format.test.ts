import { describe, expect, it } from 'vitest'
import {
  compactAmount,
  formatAmount,
  formatBps,
  formatDuration,
  formatRate,
  isHexId,
  normalizeHex,
  explorerAccountUrl,
  feeSplit,
  parseAmount,
  parseSlippagePercent,
  shortAddress,
  shortHex,
  poolPageTitle,
} from './format'

describe('isHexId', () => {
  it('accepts bare and 0x-prefixed hex regardless of first digit', () => {
    expect(isHexId('b7a3592bed7cb051151e5b0066a3f5')).toBe(true)
    expect(isHexId('0xb7a3592bed7cb051151e5b0066a3f5')).toBe(true)
    expect(isHexId('0abc')).toBe(true)
  })

  it('rejects bech32 addresses', () => {
    expect(isHexId('mtst1azxaq6gmsyxjjqfaan8he4r36vkpz4q7')).toBe(false)
  })
})

describe('normalizeHex', () => {
  it('strips 0x prefix and lowercases', () => {
    expect(normalizeHex('0xAB12')).toBe('ab12')
    expect(normalizeHex('  AB12 ')).toBe('ab12')
  })
})

describe('parseSlippagePercent', () => {
  it('reads the percentage the form asks for', () => {
    expect(parseSlippagePercent('0.5')).toBe(50n)
    expect(parseSlippagePercent('5')).toBe(500n)
    expect(parseSlippagePercent('0')).toBe(0n)
    expect(parseSlippagePercent('0.05')).toBe(5n)
    expect(parseSlippagePercent(' 1.5 % ')).toBe(150n)
  })

  it('accepts every bound the protocol allows, and no more', () => {
    // 99.99% is the widest bound basis points can express.
    expect(parseSlippagePercent('99.99')).toBe(9999n)
    expect(() => parseSlippagePercent('100')).toThrow(RangeError)
  })

  it('refuses what is not a non-negative number', () => {
    expect(() => parseSlippagePercent('-1')).toThrow(RangeError)
    expect(() => parseSlippagePercent('')).toThrow(RangeError)
    expect(() => parseSlippagePercent('half')).toThrow(RangeError)
  })
})

describe('shortHex', () => {
  it('truncates long ids', () => {
    expect(shortHex('0x1234567890abcdef', 4, 4)).toBe('0x1234…cdef')
  })

  it('returns short ids whole', () => {
    expect(shortHex('0xabcd')).toBe('0xabcd')
  })

  it('renders a bech32 id as an address, never as a 0x string', () => {
    // Two faucets of the same kind. As hex they would collide: both carry the
    // node prefix and the routing suffix, so both read `0xmtst1a…wr6w`.
    expect(shortHex('mtst1aq80tyvprm8zc5fr0xfxuv46yvmfxrem_qr7qqq9wr6w')).toBe('…mfxrem')
    expect(shortHex('mtst1az5hm04mhc8wjyf0zmugqmmx6upczkm9_qr7qqq9wr6w')).toBe('…pczkm9')
  })
})

describe('shortAddress', () => {
  it('takes the fragment before the routing suffix of a bech32 address', () => {
    // Both of these are Mico and Zaza faucets: their prefixes and suffixes match.
    expect(shortAddress('mtst1aq80tyvprm8zc5fr0xfxuv46yvmfxrem_qr7qqq9wr6w')).toBe('…mfxrem')
    expect(shortAddress('mtst1az5hm04mhc8wjyf0zmugqmmx6upczkm9_qr7qqq9wr6w')).toBe('…pczkm9')
  })

  it('takes the leading bytes of a hex id', () => {
    expect(shortAddress('0x0ef591811ece2c512379926e32ba23')).toBe('0x0ef591…')
  })

  it('leaves short values whole', () => {
    expect(shortAddress('0xabcd')).toBe('0xabcd')
  })

  it('handles an empty value', () => {
    expect(shortAddress('')).toBe('')
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

describe('formatRate', () => {
  it('renders a fraction as a percentage', () => {
    expect(formatRate(0.124)).toBe('12.4%')
    expect(formatRate(0)).toBe('0.0%')
    expect(formatRate(0.0005)).toBe('0.1%')
  })

  it('drops the decimal at and above 100%', () => {
    expect(formatRate(1.234)).toBe('123%')
    expect(formatRate(1)).toBe('100%')
  })

  it('renders a negative or non-finite rate as a dash', () => {
    expect(formatRate(-0.01)).toBe('—')
    expect(formatRate(Number.NaN)).toBe('—')
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('picks the largest whole unit', () => {
    expect(formatDuration(86400)).toBe('1d')
    expect(formatDuration(172800)).toBe('2d')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(5400)).toBe('1h')
    expect(formatDuration(90)).toBe('1m')
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(0)).toBe('0s')
  })
  it('renders a negative or non-finite duration as a dash', () => {
    // An indexer from before the field existed sends nothing at all.
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('compactAmount', () => {
  it('keeps small amounts exact', () => {
    expect(compactAmount(1234567n, 4)).toBe('123.4567')
    expect(compactAmount(0n, 6)).toBe('0')
  })

  it('shortens thousands, millions, billions, and trillions', () => {
    expect(compactAmount(1234567890n, 4)).toBe('123.4k')
    expect(compactAmount(9999999n * 10n ** 4n, 4)).toBe('9.9M')
    expect(compactAmount(2500000000n * 10n ** 4n, 4)).toBe('2.5B')
    expect(compactAmount(7n * 10n ** 12n * 10n ** 4n, 4)).toBe('7.0T')
  })

  it('marks a negative amount', () => {
    expect(compactAmount(-2500000000n, 0)).toBe('-2.5B')
  })
})

describe('poolPageTitle', () => {
  it('names the pool with its price once liquidity exists', () => {
    expect(poolPageTitle('[p0]', '0.430897', 'MICO', 'ZAZA')).toBe('[p0] 0.430897 MICO / ZAZA')
  })

  it('omits the price when the pool holds nothing', () => {
    expect(poolPageTitle('[p0]', null, 'MICO', 'ZAZA')).toBe('[p0] MICO / ZAZA')
  })
})

describe('explorerAccountUrl', () => {
  it('appends the id, with or without a trailing slash', () => {
    expect(explorerAccountUrl('https://x.test/account', '0xabc')).toBe('https://x.test/account/0xabc')
    expect(explorerAccountUrl('https://x.test/account/', '0xabc')).toBe('https://x.test/account/0xabc')
  })

  it('returns null when either side is unknown', () => {
    expect(explorerAccountUrl('', '0xabc')).toBeNull()
    expect(explorerAccountUrl('https://x.test', '')).toBeNull()
  })
})

describe('feeSplit', () => {
  it('divides the tier the swapper pays', () => {
    expect(feeSplit(30n, 1200n)).toEqual({
      effective: '0.30%',
      protocol: '0.0360%',
      lpKeeps: '0.2640%',
      share: '12.00%',
    })
  })

  it('leaves the whole tier with the LPs when the share is zero', () => {
    expect(feeSplit(100n, 0n)).toEqual({
      effective: '1.00%',
      protocol: '0.0000%',
      lpKeeps: '1.0000%',
      share: '0.00%',
    })
  })
})
