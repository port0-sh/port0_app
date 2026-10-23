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
  ConsumeTransaction,
  PrivateDataPermission,
  SendTransaction,
  Transaction,
  WalletAdapterNetwork,
  WalletReadyState,
} from '@miden-sdk/miden-wallet-adapter-base'
import type { Asset, InputNoteDetails } from '@miden-sdk/miden-wallet-adapter-base'
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

let adapterPromise: Promise<MidenWalletAdapter> | null = null
/**
 * A handshake in flight, resolving to whether the adapter ended up connected.
 * The session restore and a Login click can otherwise start two of them; the
 * adapter guards against that by resolving the second early, which reports
 * success before the connection exists. Never rejects, so a joiner can check
 * the store instead of inheriting the initiator's error.
 */
let connectInFlight: Promise<boolean> | null = null

/**
 * The last transaction this app asked the wallet to submit. Remembered so
 * `syncWallet` can drive the wallet to the current tip through
 * `waitForTransaction`, the call that made the pool-creation configure align.
 */
const LAST_TX_KEY = 'port0-app:last-wallet-tx:v1'

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

/** Drops the remembered transaction. Called when the wallet no longer has it. */
function clearWalletTx(): void {
  try {
    localStorage.removeItem(LAST_TX_KEY)
  } catch {
    // Nothing to clear.
  }
}

/**
 * The confirmed login, so a reload does not log the user out. The address is
 * enough: the extension holds the authorization, and the restore re-drives its
 * handshake, which the wallet answers from its own stored dApp session.
 */
const SESSION_KEY = 'port0-app:wallet-session:v1'

function saveSession(address: string): void {
  try {
    localStorage.setItem(SESSION_KEY, address)
  } catch {
    // Storage unavailable: the login lasts for this page only.
  }
}

function loadSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // Nothing to clear.
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
      // The wallet caches transaction results for ten minutes. A remembered id
      // older than that is stale, not a failure, and its wording would otherwise
      // be a sticky toast on every reload. Retire the id and stay quiet.
      if (/expired/i.test(error.message)) {
        clearWalletTx()
        console.warn('[wallet]', error.message)
        return
      }
      walletStore.set({ error: error.message, connecting: false })
    })

    walletStore.set({ readyState: adapter.readyState })
    return adapter
  })()
  return adapterPromise
}

/**
 * Bounds the adapter's handshake. The extension can leave it pending forever
 * (locked wallet, popup behind the window, sleeping service worker), and the
 * Login button is disabled while connecting, so without this the control is
 * stuck on "Connecting…" until a reload.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Milliseconds a user-initiated handshake may take before the app gives up. */
const CONNECT_TIMEOUT_MS = 20_000
/** Milliseconds the on-load restore waits. Shorter: it is not user-driven. */
const RESTORE_TIMEOUT_MS = 6_000
/** Milliseconds between reads of the account the extension injects. */
const INJECTED_POLL_MS = 250

const NO_ANSWER =
  'The wallet did not answer. Unlock Bread, approve the connection, and try again.'
const NO_FINISH = 'The wallet did not finish connecting. Open Bread and try again.'

/**
 * The adapter has no cancel. A handshake the extension never answers leaves its
 * internal connecting flag set, and every later `connect()` then returns early,
 * so without this a retry would need a page reload.
 */
function clearConnectingFlag(adapter: MidenWalletAdapter): void {
  ;(adapter as unknown as { _connecting: boolean })._connecting = false
}

/**
 * Watches for the account the extension injects once it authorizes the app.
 * The extension can authorize and set the address while the response that
 * settles the adapter's handshake promise is dropped, so this is the signal
 * that arrives when the other two never do.
 */
function injectedAccountWatch(adapter: MidenWalletAdapter): {
  promise: Promise<void>
  stop: () => void
} {
  let timer = 0
  const promise = new Promise<void>((resolve) => {
    timer = window.setInterval(() => {
      if (!adoptInjectedAccount(adapter)) return
      window.clearInterval(timer)
      timer = 0
      resolve()
    }, INJECTED_POLL_MS)
  })
  return {
    promise,
    stop: () => {
      if (timer) window.clearInterval(timer)
    },
  }
}

/**
 * One handshake, raced against the adapter's `connect` event and against the
 * account the extension injects. The handshake promise can stay pending while
 * the other two arrive, so any of the three is the success signal. Returns true
 * when the adapter holds an address afterwards.
 */
async function handshake(
  adapter: MidenWalletAdapter,
  timeoutMs: number,
  message: string,
): Promise<boolean> {
  // A previous attempt the extension never answered leaves the flag set, and
  // every later connect() then returns early. Clear it so this is a fresh one.
  clearConnectingFlag(adapter)
  const connected = new Promise<void>((resolve) => {
    adapter.once('connect', () => resolve())
  })
  const injected = injectedAccountWatch(adapter)
  try {
    await withTimeout(
      Promise.race([
        adapter
          .connect(
            PrivateDataPermission.Auto,
            WalletAdapterNetwork.Testnet,
            AllowedPrivateData.Assets | AllowedPrivateData.Notes,
          )
          .then(() => undefined),
        connected,
        injected.promise,
      ]),
      timeoutMs,
      message,
    )
  } finally {
    injected.stop()
    // The event wins the race but can leave the flag set; so can the promise.
    clearConnectingFlag(adapter)
  }
  return adoptAdapterState(adapter)
}

/**
 * Runs one handshake as the single in-flight attempt, so a second caller joins
 * it instead of starting another: the adapter answers a concurrent connect with
 * an immediate return, which looks like success before the wallet exists.
 * `connectInFlight` never rejects, so a joiner verifies the store itself.
 */
async function attemptConnect(
  adapter: MidenWalletAdapter,
  timeoutMs: number,
  message: string,
): Promise<boolean> {
  const task = handshake(adapter, timeoutMs, message)
  connectInFlight = task.then(
    () => true,
    () => false,
  )
  try {
    return await task
  } finally {
    connectInFlight = null
  }
}
/** Milliseconds any other wallet request may take before it is treated as failed. */
const WALLET_CALL_TIMEOUT_MS = 15_000
/** Milliseconds a disconnect waits on the extension; the local session is gone already. */
const DISCONNECT_TIMEOUT_MS = 5_000

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
  // A restore can have connected the page already; connecting again is a no-op.
  if (adoptAdapterState(adapter)) return
  if (connectInFlight) {
    // A restore is the attempt in flight. Joining it must still end connected,
    // or the click would resolve without a wallet.
    await connectInFlight
    if (!adoptAdapterState(adapter)) throw new Error(NO_FINISH)
    return
  }
  walletStore.set({ connecting: true, error: null })
  try {
    if (!(await attemptConnect(adapter, CONNECT_TIMEOUT_MS, NO_ANSWER))) {
      throw new Error(NO_FINISH)
    }
  } catch (error) {
    console.error('[wallet] connect failed:', error)
    walletStore.set({ connecting: false })
    throw error
  }
}

/**
 * Adopts the account the extension injected into the page.
 *
 * The extension can grant the permission and set `address` on its injected
 * object while the response that would settle the adapter's handshake promise
 * never arrives (observed live: the extension showed the app as connected, the
 * page kept waiting, and a reload logged the user out). The adapter reads that
 * same object, so filling in what the adapter would have set is the only
 * recovery from a dropped response. The address only exists on the injected
 * object after the extension authorized this app.
 */
function adoptInjectedAccount(adapter: MidenWalletAdapter): boolean {
  const injected = window as unknown as {
    midenWallet?: { address?: string | null; publicKey?: string | null }
    miden?: { address?: string | null; publicKey?: string | null }
  }
  const wallet = injected.midenWallet ?? injected.miden
  if (!wallet?.address) return false
  const target = adapter as unknown as {
    _address: string | null
    _publicKey: string | null
    _wallet: unknown
  }
  target._address = wallet.address
  target._publicKey = wallet.publicKey ?? null
  target._wallet = wallet
  return true
}

/**
 * Mirrors the adapter's own session into the store.
 *
 * The adapter suppresses its `connect` event when it already considers itself
 * authorized, so the absence of an event is not the absence of a session, and a
 * page that waited for one would keep asking a connected wallet to log in. The
 * adapter's own `connected` and `address` are the reliable signal.
 */
function adoptAdapterState(adapter: Awaited<ReturnType<typeof getBreadWallet>>): boolean {
  if ((!adapter.connected || !adapter.address) && !adoptInjectedAccount(adapter)) return false
  if (!adapter.connected || !adapter.address) return false
  saveSession(adapter.address)
  walletStore.set({
    kind: 'bread',
    connecting: false,
    connected: true,
    address: adapter.address,
    error: null,
  })
  return true
}

/**
 * Restores a confirmed login on page load.
 *
 * The extension holds the authorization, so it answers the handshake from its
 * own stored dApp session. The restore is silent: it never toasts, and it waits
 * less than a user click. A wallet that does not answer leaves the saved
 * session in place, so a locked wallet is retried on the next load.
 */
export async function restoreSession(): Promise<boolean> {
  const adapter = await getBreadWallet()
  if (adoptAdapterState(adapter)) return true
  if (!loadSession()) return false
  if (connectInFlight) return connectInFlight
  walletStore.set({ connecting: true, error: null })
  try {
    const connected = await attemptConnect(
      adapter,
      RESTORE_TIMEOUT_MS,
      'The wallet did not answer the session restore.',
    )
    if (!connected) walletStore.set({ connecting: false })
    return connected
  } catch (error) {
    // The response can be dropped after the extension authorized the app; the
    // injected account is then still adoptable.
    if (adoptAdapterState(adapter)) return true
    console.warn('[wallet] session restore failed:', error)
    walletStore.set({ connecting: false })
    return false
  }
}

/** Disconnect always resolves; wallet-side failures arrive on the error event. */
export async function disconnect(): Promise<void> {
  const adapter = await getBreadWallet()
  // Local first: logging out must never depend on the extension answering. A
  // half-dead wallet leaves `adapter.disconnect()` pending forever, and the
  // user is then stuck signed in with no way out.
  clearSession()
  walletStore.set({
    kind: null,
    connected: false,
    address: null,
    connecting: false,
    error: null,
  })
  try {
    await withTimeout(
      adapter.disconnect(),
      DISCONNECT_TIMEOUT_MS,
      'The wallet did not answer the disconnect request.',
    )
  } catch {
    // The local session is gone; the extension can catch up later.
  }
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
      // The guarded call: an expired result is success, and it clears the id.
      await withTimeout(waitForTransaction(txId), WALLET_CALL_TIMEOUT_MS, 'The wallet did not answer.')
    } catch {
      clearWalletTx()
      // Unknown or refused. The consumable-note read below still syncs.
    }
  }
  // Force a wallet sync. The adapter exposes no sync method; reading the
  // consumable notes makes the wallet sync first, and unlike a
  // `waitForTransaction` on an already-confirmed transaction it is never a
  // no-op. The anchor Bread captures is its sync height, so a stale store puts
  // the anchor on a later block than the request's bound block.
  await withTimeout(
    adapter.requestConsumableNotes(),
    WALLET_CALL_TIMEOUT_MS,
    'The wallet did not answer the sync request.',
  )
}

/** Polls the wallet for the on-chain result of a submitted transaction. */
export async function waitForTransaction(
  txId: string,
): Promise<{ txHash: string }> {
  try {
    const result = await (await getBreadWallet()).waitForTransaction(txId)
    return { txHash: result.txHash }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The wallet keeps transaction results for ten minutes. An older submission
    // is not a failure, the client's internal wording is not for users, and the
    // id is dead weight from here on.
    if (/expired/i.test(message)) {
      clearWalletTx()
      return { txHash: txId }
    }
    throw error
  }
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
  return withTimeout(
    adapter.requestAssets(),
    WALLET_CALL_TIMEOUT_MS,
    'The wallet did not answer the asset request.',
  )
}

/** Notes the connected wallet can consume, as the wallet reports them. */
export async function consumableNotes(): Promise<InputNoteDetails[]> {
  const adapter = await getBreadWallet()
  if (!adapter.connected) {
    throw new Error('Wallet is not connected.')
  }
  return withTimeout(
    adapter.requestConsumableNotes(),
    WALLET_CALL_TIMEOUT_MS,
    'The wallet did not answer the note request.',
  )
}

/**
 * Consumes one note through the wallet.
 *
 * Returns the transaction id. The wallet signs; the app never holds the key.
 */
export async function consumeNote(
  faucetId: string,
  noteId: string,
  noteType: 'public' | 'private',
  amount: number,
): Promise<string> {
  const adapter = await getBreadWallet()
  if (!adapter.address || !adapter.connected) {
    throw new Error('Wallet is not connected.')
  }
  const txId = await adapter.requestConsume(
    new ConsumeTransaction(faucetId, noteId, noteType, amount),
  )
  rememberWalletTx(txId)
  return txId
}

/**
 * The connected wallet's account id, parsed from its reported address.
 * Bread reports a bech32 testnet address; hex ids are also accepted.
 * Returns null when disconnected or the address fails to parse.
 */
/**
 * Dev-only console handle: `__port0Wallet.walletStore.get()` shows the live
 * wallet state (including `error`), and `disconnect()` forces a local logout.
 */
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__port0Wallet = {
    walletStore,
    connect,
    disconnect,
    restoreSession,
  }
}

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
