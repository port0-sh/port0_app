/**
 * Network identity for the places that need an id rather than an endpoint.
 *
 * The chain is chosen by name in configuration, not by a boolean, so devnet and a
 * local node are as much first-class as testnet and mainnet. Two flavours exist:
 * the network a wallet connector is told, and the chain's own network id, which
 * decides an address's bech32 prefix.
 *
 * Both resolve lazily, because the Miden SDK carries WASM and the pages that
 * render addresses already load it on demand.
 */

import type { NetworkId } from '@miden-sdk/miden-sdk'
import { CONFIG } from './config'

/**
 * The network passed to the wallet adapter handshake.
 *
 * The adapter's 0.17 enum has no mainnet member, but the value crosses to the
 * extension as a string, so the chain's own name is passed through. Verified
 * against Bread on 2026-10-23: the extension accepts `"mainnet"` and returns the
 * account, so this cast is a typing gap in the adapter, not a behaviour gap. The
 * probe that establishes it is `~/crypto/tests/bread-network`.
 */
export function walletNetwork(): string {
  switch (CONFIG.chainId) {
    case 'mainnet':
      return 'mainnet'
    case 'devnet':
      return 'devnet'
    case 'custom':
      return 'localnet'
    case 'testnet':
      return 'testnet'
  }
}

/** The chain network id, for rendering an account id as a bech32 address. */
export async function chainNetworkId(): Promise<NetworkId> {
  const { NetworkId } = await import('@miden-sdk/miden-sdk')
  switch (CONFIG.chainId) {
    case 'mainnet':
      return NetworkId.mainnet()
    case 'devnet':
      return NetworkId.devnet()
    case 'custom':
      return NetworkId.custom(CONFIG.chainPrefix ?? 'mlcl')
    case 'testnet':
      return NetworkId.testnet()
  }
}
