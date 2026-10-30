/**
 * Which pools the chain registry lists, in the app's comparison form.
 *
 * The indexer chooses the pool list; the registry is the authority. A page
 * backed by an unlisted pool renders read-only and refuses every trade, so a
 * stale indexer cannot route a user into a pool the registry never admitted.
 *
 * Read with the node's account-proof RPC and one map key per requested pool, so
 * the call costs a Merkle path instead of building the registry's storage map on
 * the main thread.
 */
import { listedRegistryPools, parseAccountId } from '@port0.sh/sdk'
import { CONFIG } from './config'
import { getRpc } from './client'
import { normalizeHex, withHexPrefix } from './format'

/**
 * The members of `poolIds` the registry holds, keyed by `normalizeHex`.
 * Throws when the read fails; a caller must not read a failure as a negative.
 */
export async function listedPools(poolIds: readonly string[]): Promise<Set<string>> {
  if (poolIds.length === 0) return new Set()
  const rpc = await getRpc()
  const registry = parseAccountId(withHexPrefix(CONFIG.registryId))
  const listed = await listedRegistryPools(
    rpc,
    registry,
    poolIds.map((id) => parseAccountId(withHexPrefix(id))),
  )
  return new Set(listed.map((id) => normalizeHex(id.toString())))
}
