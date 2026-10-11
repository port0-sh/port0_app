/**
 * Amount, id, and fee formatting. All amount math is string/bigint based;
 * floating point never touches a chain value.
 */

/** Strips an optional 0x prefix and lowercases. */
export function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, '')
}

/**
 * True when the string is a bare or 0x-prefixed hex account-id candidate.
 *
 * The prefix group is atomic: `0x?` would mean a literal `0` followed by an
 * optional `x`, so a bare id starting with any other hex digit (`b7a3…`)
 * would fail, be treated as bech32, and error on its checksum.
 */
export function isHexId(value: string): boolean {
  return /^(?:0x)?[0-9a-f]+$/i.test(value.trim())
}

/**
 * Ensures the 0x prefix `AccountId.fromHex` requires: it parses exactly 32
 * hex characters including the prefix, while this app stores bare lowercase
 * hex everywhere else.
 */
export function withHexPrefix(value: string): string {
  return `0x${normalizeHex(value)}`
}

/** "0x1234…cdef" for long hex ids. */
export function shortHex(value: string, head = 6, tail = 4): string {
  const hex = normalizeHex(value)
  if (hex.length <= head + tail) return `0x${hex}`
  return `0x${hex.slice(0, head)}…${hex.slice(-tail)}`
}

/** Trims a hex or bech32 address for display. */
export function shortAddress(value: string): string {
  const s = value.trim()
  if (s.length <= 20) return s
  return `${s.slice(0, 10)}…${s.slice(-6)}`
}

/**
 * Parses a decimal amount string into base units, exactly.
 * Accepts a plain non-negative decimal ("0", "12", "1.5").
 * Throws RangeError when the input is malformed, negative, or carries more
 * fractional digits than the asset supports.
 */
export function parseAmount(input: string, decimals: number): bigint {
  const s = input.trim().replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new RangeError(`invalid amount: ${input}`)
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`invalid decimals: ${decimals}`)
  }
  const [intPart, fracPart = ''] = s.split('.')
  if (fracPart.length > decimals) {
    throw new RangeError(`amount ${input} exceeds ${decimals} decimal places`)
  }
  return (
    BigInt(intPart) * 10n ** BigInt(decimals) +
    BigInt(fracPart.padEnd(decimals, '0') || '0')
  )
}

/** Groups an integer digit string with thousands separators. */
function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Formats base units as a grouped decimal string.
 * Trailing fractional zeros are trimmed; the dot is omitted for integers.
 */
export function formatAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const intPart = amount / base
  const frac = (amount % base)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  return frac
    ? `${groupDigits(intPart.toString())}.${frac}`
    : groupDigits(intPart.toString())
}

/** "0.30%" for bps = 30. Basis points, two decimal places. */
export function formatBps(bps: bigint): string {
  const whole = bps / 100n
  const frac = (bps % 100n).toString().padStart(2, '0')
  return `${whole}.${frac}%`
}

/**
 * A rate as a percentage: 0.124 becomes "12.4%". Rates at or above 100% lose the
 * decimal, where it carries no information. A negative or non-finite rate has no
 * meaning here and renders as a dash.
 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return '—'
  const percent = rate * 100
  return `${percent >= 100 ? percent.toFixed(0) : percent.toFixed(1)}%`
}

/** A duration in seconds as its largest whole unit: 86400 -> "1d", 90 -> "1m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds)}s`
}

/**
 * An amount shortened to three significant digits with a unit suffix, for table
 * columns: 1234567 units at 4 decimals becomes "123M". Values below a thousand
 * are rendered exactly, so small pools are not rounded to nothing.
 */
export function compactAmount(amount: bigint, decimals: number): string {
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const whole = absolute / 10n ** BigInt(decimals)
  const sign = negative ? '-' : ''
  const units: [bigint, string][] = [
    [10n ** 12n, 'T'],
    [10n ** 9n, 'B'],
    [10n ** 6n, 'M'],
    [10n ** 3n, 'k'],
  ]
  for (const [scale, suffix] of units) {
    if (whole >= scale) {
      const scaled = (absolute * 10n) / (scale * 10n ** BigInt(decimals))
      return `${sign}${scaled / 10n}.${scaled % 10n}${suffix}`
    }
  }
  return formatAmount(amount, decimals)
}
