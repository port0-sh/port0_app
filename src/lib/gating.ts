/**
 * Disabled state and copy for the three pool actions and the gate line above
 * them.
 *
 * Extracted from the page so every branch that produces a sentence a user reads
 * is decided once and pinned by a test.
 */

export type PoolAction = 'swap' | 'add' | 'remove'

export interface GateState {
  /** The wallet is connected. */
  connected: boolean
  /** The pool record carries its fee faucet id, so notes can be priced. */
  hasFees: boolean
  /** Registry membership: true, false, or null while it is being read. */
  listed: boolean | null
  /** A verification read failed, so membership is unknown, not negative. */
  unverified: boolean
  /** A pool from an earlier registry: withdrawals only. */
  legacy: boolean
  /** No liquidity providers, so the ratio is not a market price. */
  seedOnly: boolean
  /** The maintenance flag that pauses the two forms spending new assets. */
  tradingEnabled: boolean
  /** A submitted transaction is still unconfirmed. */
  pendingTx: boolean
  /** The form's own validation failed. */
  formError: boolean
}

/** A swap and a deposit spend new assets into the pool; a withdrawal does not. */
export function spendsAssets(action: PoolAction): boolean {
  return action !== 'remove'
}

export interface ActionState {
  disabled: boolean
  label: string
}

/** The button's disabled state and its label, in precedence order. */
export function actionState(state: GateState, action: PoolAction): ActionState {
  const pausable = spendsAssets(action)
  const enabled = state.connected && state.hasFees
  // A pool with no liquidity providers has no market price, so a swap cannot be
  // quoted. Adding liquidity is the way out, so that form stays open.
  const noLp = state.seedOnly && action === 'swap'
  const legacy = state.legacy && pausable
  const paused = pausable && !state.tradingEnabled

  const disabled =
    !enabled || paused || state.listed !== true || legacy || noLp || state.pendingTx || state.formError

  const label = noLp
    ? 'Add liquidity first'
    : legacy
      ? 'Legacy'
      : paused
        ? 'Under maintenance'
        : state.unverified
          ? 'Unverified'
          : state.listed === null
          ? 'Checking registry…'
          : state.listed === false
            ? 'Not listed'
            : !enabled
              ? state.connected
                ? 'Trading disabled'
                : 'Connect wallet to act'
              : state.formError
                ? 'Fix the amount first'
                : 'Submit'

  return { disabled, label }
}

/** The one line above the tabs. Empty when nothing blocks an action. */
export function gateMessage(state: GateState): string {
  if (state.seedOnly) {
    return "No liquidity providers yet. Add liquidity to set this pool's price; swaps stay disabled until then."
  }
  if (state.legacy) {
    return 'Legacy pool. This version is no longer supported; withdrawals only.'
  }
  if (state.unverified) {
    return 'This pool could not be verified against the chain registry. Reload the page to try again.'
  }
  if (state.listed === null) {
    return 'Checking this pool against the chain registry…'
  }
  if (state.listed === false) {
    return 'This pool is not listed in the chain registry. Trading is disabled; open a listed pool.'
  }
  if (!state.tradingEnabled) {
    return 'Swaps and deposits are down for maintenance. Withdrawals are open.'
  }
  if (!state.connected) {
    return 'Login to act on this pool.'
  }
  if (!state.hasFees) {
    return 'Trading is disabled for this pool: it was imported without its fee faucet id.'
  }
  return ''
}
