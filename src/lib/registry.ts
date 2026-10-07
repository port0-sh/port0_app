/**
 * The local pool registry.
 *
 * The node RPC has no account-listing-by-code-root endpoint, so chain-wide
 * discovery belongs to an indexer. What the app controls itself is a local,
 * localStorage-persisted registry of pool records. Each record stores the
 * metadata that cannot be recovered from on-chain state alone: the network
 * note-fee faucet id and the per-note-kind fee schedule, both fixed at pool
 * creation and invisible through the public account API.
 *
 * Records are untrusted input: every load validates each entry and drops
 * malformed ones. Amounts are stored as decimal strings, never bigint,
 * because JSON cannot serialize bigint.
 */

import type { NoteKind } from 'miden-xyk-sdk'
import { normalizeHex } from './format'
import { createStore, type Store } from './state'

export interface PoolRecord {
  /** Canonical account id hex (no 0x prefix), AccountId.toString(). */
  poolId: string
  /** Fee faucet for network note fees; null marks a read-only import. */
  feeFaucetId: string | null
  /** Per-note-kind consumption fees, decimal strings. */
  noteFees: Partial<Record<NoteKind, string>>
  token0FaucetId: string
  token1FaucetId: string
  token0Symbol: string
  token1Symbol: string
  token0Decimals: number
  token1Decimals: number
  /** Epoch milliseconds when the record was added. */
  addedAt: number
}

const STORAGE_KEY = 'miden-xyk-app:pool-registry:v1'
const NOTE_KINDS: readonly NoteKind[] = ['admin', 'mint', 'burn', 'swap', 'collect']

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]+$/.test(normalizeHex(value))
}

function isDecimals(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 18
  )
}

function isFeeMap(value: unknown): value is Partial<Record<NoteKind, string>> {
  if (typeof value !== 'object' || value === null) return false
  const entries = value as Record<string, unknown>
  return (
    Object.keys(entries).every((key) =>
      NOTE_KINDS.includes(key as NoteKind),
    ) &&
    NOTE_KINDS.every(
      (kind) =>
        !(kind in entries) ||
        (typeof entries[kind] === 'string' && /^\d+$/.test(entries[kind] as string)),
    )
  )
}

/** Validates one untrusted registry entry. Returns null on any violation. */
export function validateRecord(raw: unknown): PoolRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!isHex(r.poolId) || !isHex(r.token0FaucetId) || !isHex(r.token1FaucetId)) {
    return null
  }
  if (r.feeFaucetId !== null && !isHex(r.feeFaucetId)) return null
  if (!isFeeMap(r.noteFees)) return null
  if (
    typeof r.token0Symbol !== 'string' ||
    r.token0Symbol.length === 0 ||
    r.token0Symbol.length > 16 ||
    typeof r.token1Symbol !== 'string' ||
    r.token1Symbol.length === 0 ||
    r.token1Symbol.length > 16
  ) {
    return null
  }
  if (!isDecimals(r.token0Decimals) || !isDecimals(r.token1Decimals)) return null
  if (typeof r.addedAt !== 'number' || !Number.isFinite(r.addedAt)) return null
  return {
    poolId: normalizeHex(r.poolId),
    feeFaucetId: r.feeFaucetId === null ? null : normalizeHex(r.feeFaucetId as string),
    noteFees: r.noteFees as Partial<Record<NoteKind, string>>,
    token0FaucetId: normalizeHex(r.token0FaucetId),
    token1FaucetId: normalizeHex(r.token1FaucetId),
    token0Symbol: r.token0Symbol,
    token1Symbol: r.token1Symbol,
    token0Decimals: r.token0Decimals,
    token1Decimals: r.token1Decimals,
    addedAt: r.addedAt,
  }
}

/** Reads and validates the persisted registry. Any bad entry is dropped. */
export function loadRegistry(storage: Pick<Storage, 'getItem'>): PoolRecord[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .map(validateRecord)
      .filter((record): record is PoolRecord => record !== null)
  } catch {
    return []
  }
}

export class RegistryStore {
  private readonly store: Store<PoolRecord[]>

  constructor(private readonly storage: Storage | null) {
    this.store = createStore<PoolRecord[]>(
      storage ? loadRegistry(storage) : [],
    )
  }

  list(): PoolRecord[] {
    return this.store.get()
  }

  get(poolId: string): PoolRecord | undefined {
    const key = normalizeHex(poolId)
    return this.store.get().find((record) => record.poolId === key)
  }

  /** Adds a record, replacing an existing one with the same pool id. */
  add(record: PoolRecord): void {
    const key = normalizeHex(record.poolId)
    this.store.set((current) => [
      ...current.filter((entry) => entry.poolId !== key),
      { ...record, poolId: key },
    ].sort((a, b) => a.addedAt - b.addedAt))
    this.persist()
  }

  remove(poolId: string): void {
    const key = normalizeHex(poolId)
    this.store.set((current) => current.filter((entry) => entry.poolId !== key))
    this.persist()
  }

  subscribe(listener: (records: PoolRecord[]) => void): () => void {
    return this.store.subscribe(listener)
  }

  private persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.store.get()))
    } catch {
      // Storage full or unavailable: the in-memory registry still works.
    }
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** The app-wide registry singleton. */
export const registry = new RegistryStore(browserStorage())
