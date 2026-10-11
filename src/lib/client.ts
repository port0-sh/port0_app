/**
 * Lazy access to the Miden SDK stack.
 *
 * The stack (@miden-sdk/miden-sdk + miden-xyk-sdk) ships megabytes of WASM.
 * Pages import this module freely; the heavy payload is fetched and
 * initialized only on first use. Keep this module free of eager imports.
 */

import type { Account, AccountId, MidenClient } from '@miden-sdk/miden-sdk'
import type { XykClient } from 'miden-xyk-sdk'
import { CONFIG } from './config'
import { isHexId, withHexPrefix } from './format'

let sdkModulePromise: Promise<typeof import('@miden-sdk/miden-sdk')> | null = null
let xykModulePromise: Promise<typeof import('miden-xyk-sdk')> | null = null
let midenClient: Promise<MidenClient> | null = null
let xykClient: Promise<XykClient> | null = null

/** Cached module loader; the WASM-heavy SDK loads once on first use. */
export function sdkModule(): Promise<typeof import('@miden-sdk/miden-sdk')> {
  sdkModulePromise ??= import('@miden-sdk/miden-sdk')
  return sdkModulePromise
}

/** Cached module loader for the XYK SDK. */
export function xykModule(): Promise<typeof import('miden-xyk-sdk')> {
  xykModulePromise ??= import('miden-xyk-sdk')
  return xykModulePromise
}

/** The resolved XYK SDK module namespace. */
export type XykModule = typeof import('miden-xyk-sdk')

/** Returns the shared MidenClient, creating it on first call. */
export async function getClient(): Promise<MidenClient> {
  midenClient ??= (async () => {
    const { MidenClient } = await sdkModule()
    return MidenClient.create({
      rpcUrl: CONFIG.midenRpcUrl,
      feeFaucetId: CONFIG.chainFeeFaucetId,
      proverUrl: 'testnet',
      autoSync: false,
    })
  })()
  return midenClient
}

/** Returns the shared XykClient facade, creating it on first call. */
export async function getXyk(): Promise<XykClient> {
  xykClient ??= (async () => {
    const { XykClient } = await xykModule()
    return XykClient.from(await getClient())
  })()
  return xykClient
}

/**
 * Fetches a public account by id, importing it from the node when the local
 * store does not track it. Account ids are accepted as hex strings (the
 * canonical format used throughout this app) or AccountId objects.
 */
export async function getPublicAccount(
  accountId: string | AccountId,
): Promise<Account> {
  const ref =
    typeof accountId === 'string'
      ? isHexId(accountId)
        ? withHexPrefix(accountId.trim())
        : accountId.trim()
      : accountId.toString()
  // Pass a string: getOrImport resolves it itself (hex with 0x prefix or
  // bech32), and strings cross the worker boundary safely.
  return (await getClient()).accounts.getOrImport(ref)
}
