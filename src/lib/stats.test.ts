import { describe, expect, it } from 'vitest'

import { feeAssetTotals, type FeeAssetPool } from './stats'

const USDCX = '0xe69e6ca6e39df1b10c1e5399399feb'
const USDT = '0x5cb79d29507d3ad17bb6dc60279e89'
const PYUSD = '0xeb4266c94493b091380b25349fddd3'
const ETH = '0x419f8f4bff72959132aa7cea15a4c1'
const MICO = '0x385341329733ff1135b6f1f46c6caf'
const HOPPER = '0x241e76acafc220111b77e33d53f0a1'

const TRUSTED = [USDCX, USDT, PYUSD]
const FEE_DECIMALS = 6

function pool(over: Partial<FeeAssetPool>): FeeAssetPool {
  return {
    id: '0x0',
    token0: USDCX,
    token1: ETH,
    reserve0: '0',
    reserve1: '0',
    token0_decimals: 6,
    token1_decimals: 8,
    volume_24h_0: '0',
    volume_24h_1: '0',
    ...over,
  }
}

describe('feeAssetTotals', () => {
  it('counts both sides of a volatile pair through the pool\'s own ratio', () => {
    const totals = feeAssetTotals([pool({ reserve0: '40000000' })], TRUSTED, FEE_DECIMALS)
    // 40 USDCX of ETH is in the pool beside the 40 USDCX; the ratio makes the
    // legs equal in value.
    expect(totals.tvlBase).toBe(80000000n)
    expect(totals.counted).toBe(1)
    expect(totals.excluded).toBe(0)
  })

  it('counts both legs of a pool between two dollars', () => {
    const totals = feeAssetTotals(
      [pool({ token1: USDT, reserve0: '5000000', reserve1: '5000000', token1_decimals: 6 })],
      TRUSTED,
      FEE_DECIMALS,
    )
    expect(totals.tvlBase).toBe(10000000n)
  })

  it('counts a bridged dollar in a pool with no fee asset', () => {
    // The case the old rule missed: USDT/PYUSD is liquidity, not a curiosity.
    const totals = feeAssetTotals(
      [pool({ token0: USDT, token1: PYUSD, reserve0: '2500000', reserve1: '2500000', token0_decimals: 6, token1_decimals: 6 })],
      TRUSTED,
      FEE_DECIMALS,
    )
    expect(totals.tvlBase).toBe(5000000n)
    expect(totals.counted).toBe(1)
  })

  it('adds nothing for a pool priced only through another pool', () => {
    // HOPPER/MICO holds no dollar. Valuing it through MICO/USDCX is how a dust
    // pool turned half a million test tokens into 3.87M USDCX of "TVL".
    const totals = feeAssetTotals(
      [
        pool({ id: '0x1', reserve0: '40000000' }),
        pool({
          id: '0x2',
          token0: HOPPER,
          token1: MICO,
          reserve0: '4994155760',
          reserve1: '5002582135',
          token0_decimals: 4,
          token1_decimals: 4,
        }),
      ],
      TRUSTED,
      FEE_DECIMALS,
    )
    expect(totals.tvlBase).toBe(80000000n)
    expect(totals.excluded).toBe(1)
  })

  it('converts a counted leg from its own decimals', () => {
    // A dollar with 8 decimals counts as the same amount of fee-asset units.
    const totals = feeAssetTotals(
      [pool({ token1: USDT, reserve1: '500000000', token1_decimals: 8 })],
      TRUSTED,
      FEE_DECIMALS,
    )
    expect(totals.tvlBase).toBe(5000000n)
  })

  it('sums volume on the counted legs only', () => {
    const totals = feeAssetTotals(
      [pool({ reserve0: '40000000', volume_24h_0: '1500', volume_24h_1: '999999' })],
      TRUSTED,
      FEE_DECIMALS,
    )
    expect(totals.volumeBase).toBe(1500n)
  })

  it('is empty for no pools', () => {
    expect(feeAssetTotals([], TRUSTED, FEE_DECIMALS)).toEqual({
      tvlBase: 0n,
      volumeBase: 0n,
      counted: 0,
      excluded: 0,
    })
  })
})
