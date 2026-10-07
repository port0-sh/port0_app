/**
 * Unified wallet facade: one store, one connect/submit surface.
 *
 * Bread Wallet is wired through @miden-sdk/miden-wallet-adapter-miden: the
 * app builds TransactionRequests with the XYK SDK and hands them to the
 * wallet, which signs and submits. Para Wallet is a planned second adapter;
 * it is gated until @miden-sdk/para ships a 0.16.x release matching the
 * testnet the app targets.
 *
 * The adapter package imports the Miden SDK eagerly, so it is loaded lazily
 * here: the Login button renders without pulling the WASM stack into the
 * page, and the adapter is constructed once on first use (identity must
 * never change after that).
 */

import {
  AllowedPrivateData,
  PrivateDataPermission,
  SendTransaction,
  Transaction,
  WalletAdapterNetwork,
  WalletReadyState,
} from '@miden-sdk/miden-wallet-adapter-base'
import type { Asset } from '@miden-sdk/miden-wallet-adapter-base'
import type { MidenWalletAdapter } from '@miden-sdk/miden-wallet-adapter-miden'
import type { AccountId, TransactionRequest } from '@miden-sdk/miden-sdk'
import { CONFIG } from '../lib/config'
import { createStore } from '../lib/state'

export type WalletKind = 'bread' | 'para'

export interface WalletState {
  kind: WalletKind | null
  readyState: WalletReadyState
  connecting: boolean
  connected: boolean
  /** Wallet-reported address (bech32), or null when disconnected. */
  address: string | null
  /** Last adapter error message, if any. */
  error: string | null
}

export const walletStore = createStore<WalletState>({
  kind: null,
  readyState: WalletReadyState.NotDetected,
  connecting: false,
  connected: false,
  address: null,
  error: null,
})

/**
 * Session persistence. Every page load is a fresh JS context (this is an
 * MPA), so the connected state must be restored from localStorage and the
 * wallet handshake re-driven; the wallet itself then answers from its own
 * stored dApp session without prompting (unless it locked meanwhile).
 */
const SESSION_KEY = 'miden-xyk-app:wallet-session:v1'

interface SavedSession {
  kind: 'bread'
  address: string
}

function saveSession(address: string): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ kind: 'bread', address }))
  } catch {
    // Storage unavailable: the session simply does not survive reloads.
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // ignore
  }
}

function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as SavedSession).kind === 'bread' &&
      typeof (parsed as SavedSession).address === 'string'
    ) {
      return parsed as SavedSession
    }
    return null
  } catch {
    return null
  }
}

let adapterPromise: Promise<MidenWalletAdapter> | null = null

/**
 * The last transaction this app asked the wallet to submit. Remembered so
 * `syncWallet` can drive the wallet to the current tip through
 * `waitForTransaction`, the call that made the pool-creation configure align.
 */
const LAST_TX_KEY = 'miden-xyk-app:last-wallet-tx:v1'

function rememberWalletTx(txId: string): void {
  try {
    localStorage.setItem(LAST_TX_KEY, txId)
  } catch {
    // Storage unavailable: syncWallet falls back to a store read.
  }
}

function lastWalletTx(): string | null {
  try {
    return localStorage.getItem(LAST_TX_KEY)
  } catch {
    return null
  }
}

/** Loads and constructs the Bread adapter once; identity stays stable. */
export function getBreadWallet(): Promise<MidenWalletAdapter> {
  adapterPromise ??= (async () => {
    const { MidenWalletAdapter } = await import(
      '@miden-sdk/miden-wallet-adapter-miden'
    )
    const adapter = new MidenWalletAdapter({ appName: CONFIG.appName })

    adapter.on('readyStateChange', (readyState) => {
      walletStore.set({ readyState })
    })
    adapter.on('connect', (address) => {
      saveSession(address)
      walletStore.set({
        kind: 'bread',
        connecting: false,
        connected: true,
        address,
        error: null,
      })
    })
    adapter.on('disconnect', () => {
      clearSession()
      walletStore.set({ kind: null, connected: false, address: null })
    })
    adapter.on('error', (error) => {
      walletStore.set({ error: error.message, connecting: false })
    })

    walletStore.set({ readyState: adapter.readyState })
    return adapter
  })()
  return adapterPromise
}

export async function connect(kind: WalletKind): Promise<void> {
  if (kind === 'para') {
    throw new Error(
      CONFIG.paraApiKey
        ? 'Para login is not wired yet. The 0.17 packages are installed; set VITE_PARA_API_KEY and the flow will be enabled next.'
        : 'Para requires VITE_PARA_API_KEY (see .env.example). The 0.17 packages are installed but the login flow ships next.',
    )
  }
  const adapter = await getBreadWallet()
  if (adapter.readyState === WalletReadyState.NotDetected) {
    window.open(adapter.url, '_blank', 'noopener')
    throw new Error(
      'Bread Wallet extension not detected. Install it and reload the page.',
    )
  }
  if (adapter.readyState === WalletReadyState.Unsupported) {
    throw new Error('Wallet extensions are not supported in this browser.')
  }
  walletStore.set({ connecting: true, error: null })
  try {
    await adapter.connect(
      PrivateDataPermission.Auto,
      WalletAdapterNetwork.Testnet,
      AllowedPrivateData.Assets | AllowedPrivateData.Notes,
    )
  } catch (error) {
    walletStore.set({ connecting: false })
    throw error
  }
}

/**
 * Restores a previously saved session on page load. Re-drives the wallet
 * handshake without user interaction; the wallet answers from its own stored
 * dApp session (an unlock prompt appears only when the wallet locked since).
 * Returns true when the session was restored. Failures are silent: the user
 * can still log in manually.
 */
export async function restoreSession(): Promise<boolean> {
  const saved = loadSession()
  if (!saved) return false
  const adapter = await getBreadWallet()
  if (adapter.connected) return true
  if (adapter.readyState !== WalletReadyState.Installed) return false
  walletStore.set({ connecting: true, error: null })
  try {
    await adapter.connect(
      PrivateDataPermission.Auto,
      WalletAdapterNetwork.Testnet,
      AllowedPrivateData.Assets | AllowedPrivateData.Notes,
    )
    return adapter.connected
  } catch {
    // Locked wallet, transient failure: stay logged out, keep the saved
    // session for the next page load.
    walletStore.set({ connecting: false })
    return false
  }
}

/** Disconnect always resolves; wallet-side failures arrive on the error event. */
export async function disconnect(): Promise<void> {
  await (await getBreadWallet()).disconnect()
}

/**
 * Submits a TransactionRequest built by the XYK SDK through the connected
 * wallet. Returns the wallet's transaction id, which names a transaction the
 * wallet accepted, not one that landed; poll waitForTransaction for that.
 *
 * The wallet captures a ChainAnchor at its own sync height when it executes a
 * custom request, and validates the multisig summary against it. A 0.17
 * multisig summary binds the request's declared bound block, so the two agree
 * only when the wallet's sync height equals that block. The wallet account is
 * private, so the app cannot execute the request itself; keeping the wallet
 * synced to the app's bound block is the app-side lever.
 */
export async function submitViaWallet(
  request: TransactionRequest,
): Promise<string> {
  const adapter = await getBreadWallet()
  const address = adapter.address
  if (!address || !adapter.connected) {
    throw new Error('Wallet is not connected.')
  }
  const envelope = Transaction.createCustomTransaction(address, address, request)
  const txId = await adapter.requestTransaction(envelope)
  rememberWalletTx(txId)
  return txId
}

/**
 * Drives the wallet to the current tip before we build a request.
 *
 * The wallet syncs inside `requestTransaction` and captures its `ChainAnchor`
 * at the resulting height. If that sync is the first of the session it spans a
 * block (the testnet interval is 3s), so the anchor lands one block after the
 * bound block we read from our own sync, and Bread rejects the multisig summary.
 * A `waitForTransaction` on the last submitted transaction forces the sync
 * first; the in-request sync is then incremental and does not cross a block.
 * With no remembered transaction, a store read is the best available nudge.
 */
export async function syncWallet(): Promise<void> {
  const adapter = await getBreadWallet()
  if (!adapter.connected) {
    throw new Error('Wallet is not connected.')
  }
  const txId = lastWalletTx()
  if (txId) {
    try {
      await adapter.waitForTransaction(txId)
    } catch {
      // Unknown or too old: fall through to the store read.
      await adapter.requestConsumableNotes()
    }
    return
  }
  await adapter.requestConsumableNotes()
}

/** Polls the wallet for the on-chain result of a submitted transaction. */
export async function waitForTransaction(
  txId: string,
): Promise<{ txHash: string }> {
  const result = await (await getBreadWallet()).waitForTransaction(txId)
  return { txHash: result.txHash }
}



/**
 * Has the connected wallet send `amount` base units of `faucetId`'s asset to
 * `recipientAddress` as a public note. Returns the wallet's transaction id.
 */
export async function sendViaWallet(
  recipientAddress: string,
  faucetId: string,
  amount: number,
): Promise<string> {
  const adapter = await getBreadWallet()
  if (!adapter.address || !adapter.connected) {
    throw new Error('Wallet is not connected.')
  }
  const txId = await adapter.requestSend(
    new SendTransaction(adapter.address, recipientAddress, faucetId, 'public', amount),
  )
  rememberWalletTx(txId)
  return txId
}

/** The connected wallet's assets (may prompt; depends on the connected permission). */
export async function requestAssets(): Promise<Asset[]> {
  const adapter = await getBreadWallet()
  if (!adapter.connected) {
    throw new Error('Wallet is not connected.')
  }
  return adapter.requestAssets()
}

/**
 * The connected wallet's account id, parsed from its reported address.
 * Bread reports a bech32 testnet address; hex ids are also accepted.
 * Returns null when disconnected or the address fails to parse.
 */
export async function walletAccountId(): Promise<AccountId | null> {
  const address = walletStore.get().address
  if (!address || !walletStore.get().connected) return null
  const { AccountId } = await import('@miden-sdk/miden-sdk')
  try {
    return /^0x[0-9a-f]+$/i.test(address)
      ? AccountId.fromHex(address)
      : AccountId.fromBech32(address)
  } catch {
    return null
  }
}
