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
  // A value that is not hex is an address in another notation, and only its own
  // formatter knows which characters tell two apart. Prefixing a bech32 address
  // with 0x would also hide them: every address shares that prefix and its
  // routing suffix, so every token would read the same.
  if (!/^[0-9a-f]+$/.test(hex)) return shortAddress(value)
  if (hex.length <= head + tail) return `0x${hex}`
  return `0x${hex.slice(0, head)}…${hex.slice(-tail)}`
}

/** Trims a hex or bech32 address for display. */
export function shortAddress(value: string): string {
  const s = value.trim()
  if (s.length === 0) return s
  // A bech32 address is `mtst1a` + hash + `_` + routing suffix. The prefix and
  // the suffix are identical for every account of a kind, so the characters
  // that tell two apart are the ones immediately before the underscore.
  const routing = s.indexOf('_')
  if (routing > 0) return `…${s.slice(0, routing).slice(-6)}`
  // A hex id is prefix felt first, and its distinct bytes lead.
  if (s.startsWith('0x')) return s.length <= 8 ? s : `0x${s.slice(2, 8)}…`
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`
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

/**
 * The tab title of a pool page: mark, price, pair.
 *
 * A pool page has no URL of its own beyond `?id=`, so the title is what tells
 * several open pools apart. The price is omitted until the pool holds liquidity,
 * which is why it is nullable rather than rendered as a placeholder.
 */
export function poolPageTitle(
  markText: string,
  price: string | null,
  token0: string,
  token1: string,
): string {
  return [markText, price ?? '', `${token0} / ${token1}`]
    .filter((part) => part.length > 0)
    .join(' ')
}

/** Explorer URL for an account, or null when no explorer is configured. */
export function explorerAccountUrl(base: string, id: string): string | null {
  const root = base.trim().replace(/\/+$/, '')
  return root.length === 0 || id.length === 0 ? null : `${root}/${id}`
}

/**
 * How a fee tier is divided.
 *
 * The swapper pays the LP fee tier; the protocol takes a share of it, so the
 * protocol's cut is inside the effective fee rather than added to it. Percentages
 * are display values, which is why they are strings here.
 */
export function feeSplit(
  lpFeeBps: bigint,
  shareBps: bigint,
): { effective: string; protocol: string; lpKeeps: string; share: string } {
  const lp = Number(lpFeeBps)
  const share = Number(shareBps)
  const protocolBps = (lp * share) / 10_000
  const percent = (bps: number): string => `${(bps / 100).toFixed(4)}%`
  return {
    effective: formatBps(lpFeeBps),
    protocol: percent(protocolBps),
    lpKeeps: percent(lp - protocolBps),
    share: formatBps(shareBps),
  }
}

/** The widest slippage a swap can carry, in basis points: 99.99%. */
export const MAX_SLIPPAGE_BPS = 9999

/**
 * Parses a slippage field entered as a percentage.
 *
 * The forms ask for percent because that is what people think in; the protocol
 * takes basis points. `0.5` is 50 bps. There is no ceiling below the protocol's
 * own: a user who wants a 20% bound gets a warning, not a refusal.
 */
export function parseSlippagePercent(value: string): bigint {
  const text = value.trim().replace(/%$/, '').trim()
  if (text === '' || !/^\d+(\.\d+)?$/.test(text)) {
    throw new RangeError('Enter a slippage percentage, for example 0.5.')
  }
  const bps = Math.round(Number(text) * 100)
  if (!Number.isFinite(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new RangeError('Slippage must be between 0% and 99.99%.')
  }
  return BigInt(bps)
}
