/**
 * Fixed-supply token parameters and validation.
 *
 * A minted token is a fixed-supply fungible asset: the faucet is created with
 * maxSupply equal to the initial supply and the whole supply is minted to the
 * caller's wallet in the same flow. Nothing remains to mint afterwards.
 *
 * The supply bound is the port0 contract's MAX_AMOUNT (2^57): every pool
 * amount must stay below it (u64 amounts with u128 intermediates and 10_000
 * bps headroom). The caller passes the SDK's MAX_AMOUNT; the default below
 * mirrors it so the pure module stays testable without the SDK.
 *
 * 0.17 protocol rule: faucet symbols are 1 to 12 uppercase ASCII letters, and a
 * faucet's name is UTF-8 up to 32 bytes. Both bounds are the standards'
 * (`TokenSymbol::MAX_SYMBOL_LENGTH`, `TokenName::MAX_BYTES`).
 */

import { parseAmount } from './format'

export const SYMBOL_MIN_LENGTH = 3
/** The protocol's `TokenSymbol::MAX_SYMBOL_LENGTH`. */
export const SYMBOL_MAX_LENGTH = 12
/** Longest display name, in characters. 32 ASCII characters are 32 bytes. */
export const NAME_MAX_CHARS = 32
/** The protocol's `TokenName::MAX_BYTES`, measured in UTF-8 bytes. */
export const NAME_MAX_BYTES = 32
export const DECIMALS_MIN = 0
export const DECIMALS_MAX = 8
export const DEFAULT_DECIMALS = 4
export const DEFAULT_INITIAL_SUPPLY = '1000000'
/** Mirrors the XYK contract MAX_AMOUNT; see module docs. */
export const MAX_INITIAL_SUPPLY = 1n << 57n

/** Returns an error message, or null when valid. Symbols are normalized to uppercase. */
export function validateSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase()
  if (symbol.length < SYMBOL_MIN_LENGTH) {
    return `Symbol must be at least ${SYMBOL_MIN_LENGTH} characters.`
  }
  if (symbol.length > SYMBOL_MAX_LENGTH) {
    return `Symbol must be at most ${SYMBOL_MAX_LENGTH} characters.`
  }
  if (!/^[A-Z]+$/.test(symbol)) {
    return 'Symbol must be uppercase ASCII letters only.'
  }
  return null
}

/**
 * Returns an error message, or null when the display name is usable.
 *
 * The user-facing bound is `NAME_MAX_CHARS` characters. The protocol stores the
 * name as UTF-8 in `NAME_MAX_BYTES`, so a name of accented or emoji characters
 * runs out of bytes before it runs out of characters; that case reports the byte
 * limit in the terms of the characters that caused it. An empty name is valid:
 * the faucet then takes the symbol as its name.
 */
export function validateTokenName(raw: string): string | null {
  const name = raw.trim()
  if (name === '') return null
  if ([...name].length > NAME_MAX_CHARS) {
    return `Name must be at most ${NAME_MAX_CHARS} characters.`
  }
  // Checked per code point rather than with a character-class regex, which the
  // lint rules reject as a control-character match.
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return 'Name must not contain control characters.'
    }
  }
  if (new TextEncoder().encode(name).length > NAME_MAX_BYTES) {
    return `Name is too long: it must fit ${NAME_MAX_BYTES} bytes, and accented or emoji characters take more than one each. Use fewer or plainer characters.`
  }
  return null
}

/** The name a faucet should carry: the trimmed name, or the symbol when empty. */
export function tokenNameOrDefault(rawName: string, symbol: string): string {
  const name = rawName.trim()
  return name === '' ? symbol : name
}

/** Normalizes a validated symbol to its canonical uppercase form. */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase()
}

/** Returns an error message, or null when valid. */
export function validateDecimals(value: number): string | null {
  if (!Number.isInteger(value) || value < DECIMALS_MIN) {
    return `Decimals must be at least ${DECIMALS_MIN}.`
  }
  if (value > DECIMALS_MAX) {
    return `Decimals must be at most ${DECIMALS_MAX}.`
  }
  return null
}

/**
 * Returns an error message, or null when valid. Supply is entered in tokens
 * and converted to base units by decimals. `maxAmount` bounds the base units;
 * defaults to the XYK MAX_AMOUNT mirror.
 */
export function validateInitialSupply(
  raw: string,
  decimals: number,
  maxAmount: bigint = MAX_INITIAL_SUPPLY,
): string | null {
  if (!raw.trim()) return 'Initial supply is required.'
  let amount: bigint
  try {
    amount = parseAmount(raw, decimals)
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid amount.'
  }
  if (amount <= 0n) return 'Initial supply must be greater than 0.'
  if (amount > maxAmount) {
    return `Initial supply must not exceed ${maxAmount.toLocaleString('en-US')} base units.`
  }
  return null
}

/** Parses a validated supply string into base units. */
export function parseInitialSupply(raw: string, decimals: number): bigint {
  return parseAmount(raw, decimals)
}
