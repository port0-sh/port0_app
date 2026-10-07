/**
 * Amount, id, and fee formatting. All amount math is string/bigint based;
 * floating point never touches a chain value.
 */

/** Strips an optional 0x prefix and lowercases. */
export function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, '')
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
