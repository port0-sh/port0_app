import { describe, expect, it } from 'vitest'
import {
  loadRegistry,
  RegistryStore,
  validateRecord,
  type PoolRecord,
} from './registry'

function validRecord(overrides: Partial<PoolRecord> = {}): PoolRecord {
  return {
    poolId: 'a1b2',
    feeFaucetId: 'c3d4',
    noteFees: { swap: '10', mint: '20' },
    token0FaucetId: 'e5f6',
    token1FaucetId: 'a7b8',
    token0Symbol: 'WETH',
    token1Symbol: 'POL',
    token0Decimals: 8,
    token1Decimals: 12,
    addedAt: 1700000000000,
    ...overrides,
  }
}

describe('validateRecord', () => {
  it('accepts a well-formed record and normalizes hex', () => {
    const record = validateRecord(validRecord({ poolId: '0xA1B2' }))
    expect(record).not.toBeNull()
    expect(record!.poolId).toBe('a1b2')
  })

  it('accepts a read-only record with null fee faucet', () => {
    expect(validateRecord(validRecord({ feeFaucetId: null }))).not.toBeNull()
  })

  it('rejects non-objects', () => {
    expect(validateRecord(null)).toBeNull()
    expect(validateRecord('x')).toBeNull()
    expect(validateRecord(42)).toBeNull()
  })

  it('rejects bad hex ids', () => {
    expect(validateRecord(validRecord({ poolId: 'zz' }))).toBeNull()
    expect(validateRecord(validRecord({ feeFaucetId: '0x' }))).toBeNull()
    expect(validateRecord(validRecord({ token0FaucetId: '' }))).toBeNull()
  })

  it('rejects bad fee maps', () => {
    expect(
      validateRecord(validRecord({ noteFees: { swap: -1 as unknown as string } })),
    ).toBeNull()
    expect(
      validateRecord(validRecord({ noteFees: { bogus: '1' } as unknown as PoolRecord['noteFees'] })),
    ).toBeNull()
    expect(
      validateRecord(validRecord({ noteFees: 'x' as unknown as PoolRecord['noteFees'] })),
    ).toBeNull()
  })

  it('rejects bad symbols', () => {
    expect(validateRecord(validRecord({ token0Symbol: '' }))).toBeNull()
    expect(validateRecord(validRecord({ token1Symbol: 'x'.repeat(17) }))).toBeNull()
  })

  it('rejects bad decimals', () => {
    expect(validateRecord(validRecord({ token0Decimals: -1 }))).toBeNull()
    expect(validateRecord(validRecord({ token1Decimals: 2.5 }))).toBeNull()
  })

  it('rejects bad timestamps', () => {
    expect(validateRecord(validRecord({ addedAt: Number.NaN }))).toBeNull()
  })
})

describe('loadRegistry', () => {
  function storage(raw: string): Pick<Storage, 'getItem'> {
    return { getItem: () => raw }
  }

  it('returns empty for missing or corrupt data', () => {
    expect(loadRegistry(storage('not json'))).toEqual([])
    expect(loadRegistry(storage('{"a":1}'))).toEqual([])
  })

  it('drops malformed entries, keeps valid ones', () => {
    const good = validRecord()
    const raw = JSON.stringify([good, { poolId: 'zz' }, null])
    const loaded = loadRegistry(storage(raw))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.poolId).toBe('a1b2')
  })
})

describe('RegistryStore', () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>()
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value)
      },
      removeItem: (key: string) => {
        map.delete(key)
      },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      },
    }
  }

  it('adds, dedupes by pool id, and persists', () => {
    const storage = fakeStorage()
    const store = new RegistryStore(storage)
    store.add(validRecord())
    store.add(validRecord({ token0Symbol: 'LATER' }))
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.token0Symbol).toBe('LATER')
    expect(loadRegistry(storage)).toHaveLength(1)
  })

  it('removes by pool id', () => {
    const store = new RegistryStore(fakeStorage())
    store.add(validRecord())
    store.remove('a1b2')
    expect(store.list()).toEqual([])
  })

  it('finds records by canonical id', () => {
    const store = new RegistryStore(fakeStorage())
    store.add(validRecord())
    expect(store.get('0xA1B2')?.poolId).toBe('a1b2')
    expect(store.get('ffff')).toBeUndefined()
  })

  it('works with null storage (in-memory only)', () => {
    const store = new RegistryStore(null)
    store.add(validRecord())
    expect(store.list()).toHaveLength(1)
  })
})
