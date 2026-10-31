/**
 * Refund detection for spot trades.
 *
 * The pool cannot abort a trade that misses its minimum: it consumes the note,
 * pays the note's assets back to the sender as one P2ID note, and leaves the
 * reserves alone. That refund note is the only positive evidence that the trade
 * did not fill, because an unchanged pool state is also what a slow pool looks
 * like.
 */

import type { InputNoteDetails } from '@miden-sdk/miden-wallet-adapter-base'
import { sdkModule } from './client'
import { isHexId, normalizeHex } from './format'

/** One asset of a refund note, in base units. */
export interface RefundAsset {
  faucetId: string
  amount: bigint
}

/** A refund note the wallet holds: the assets the pool paid back. */
export interface Refund {
  note: InputNoteDetails
  assets: RefundAsset[]
}

/**
 * Normalizes an account id the wallet reported, which may be bech32. Returns
 * null when the value is not an account id.
 */
export async function normalizeWalletAccount(raw: string): Promise<string | null> {
  const value = raw.trim()
  if (isHexId(value)) return normalizeHex(value)
  try {
    const { AccountId } = await sdkModule()
    return normalizeHex(AccountId.fromBech32(value).toString())
  } catch {
    return null
  }
}

/**
 * The pool's refund note among the wallet's notes.
 *
 * The note counts only when its sender is `poolId`, its assets include one of
 * `faucets`, and its id is not in `seen`. `seen` is the wallet's notes before the
 * trade, so a refund an earlier attempt left behind is not mistaken for this
 * one. The assets list carries every faucet of `faucets` the note holds, because
 * an add's refund pays both tokens in one note.
 */
export async function findRefund(
  notes: readonly InputNoteDetails[],
  poolId: string,
  faucets: readonly string[],
  seen: ReadonlySet<string> = new Set(),
): Promise<Refund | null> {
  const pool = normalizeHex(poolId)
  const wanted = new Set(faucets.map((faucet) => normalizeHex(faucet)))
  for (const note of notes) {
    if (seen.has(note.noteId)) continue
    if (note.senderAccountId === undefined) continue
    const sender = await normalizeWalletAccount(note.senderAccountId)
    if (sender !== pool) continue
    const assets: RefundAsset[] = []
    for (const asset of note.assets) {
      const faucet = await normalizeWalletAccount(asset.faucetId)
      if (faucet === null || !wanted.has(faucet)) continue
      let amount: bigint
      try {
        amount = BigInt(asset.amount)
      } catch {
        continue
      }
      if (amount > 0n) assets.push({ faucetId: faucet, amount })
    }
    if (assets.length > 0) return { note, assets }
  }
  return null
}
