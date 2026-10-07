/**
 * Launchpad token parameters and validation.
 *
 * A launched token is a fixed-supply fungible asset: the faucet is created
 * with maxSupply equal to the initial supply and the whole supply is minted
 * to the creator's wallet in the same transaction flow. Nobody can mint more.
 *
 * The supply bound is the XYK contract's MAX_AMOUNT (2^57): every pool
 * amount must stay below it (u64 amounts with u128 intermediates and 10_000
 * bps headroom). The caller passes the SDK's MAX_AMOUNT; the default below
 * mirrors it so the pure module stays testable without the SDK.
 *
 * 0.17 protocol rule: faucet symbols are uppercase ASCII letters only.
 */

import { parseAmount } from './format'

export const SYMBOL_MIN_LENGTH = 3
export const SYMBOL_MAX_LENGTH = 6
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
