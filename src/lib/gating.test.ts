import { describe, expect, it } from 'vitest'
import { actionState, gateMessage, type GateState } from './gating'

/** A connected wallet, a listed pool, trading on, nothing pending or invalid. */
const OPEN: GateState = {
  connected: true,
  hasFees: true,
  listed: true,
  unverified: false,
  legacy: false,
  seedOnly: false,
  tradingEnabled: true,
  pendingTx: false,
  formError: false,
}

describe('pool action gating', () => {
  it('opens every action on an open pool', () => {
    for (const action of ['swap', 'add', 'remove'] as const) {
      expect(actionState(OPEN, action)).toEqual({ disabled: false, label: 'Submit' })
    }
    expect(gateMessage(OPEN)).toBe('')
  })

  it('blocks a swap but opens the deposit on a pool with no liquidity', () => {
    const state = { ...OPEN, seedOnly: true }
    expect(actionState(state, 'swap')).toEqual({ disabled: true, label: 'Add liquidity first' })
    expect(actionState(state, 'add')).toEqual({ disabled: false, label: 'Submit' })
    expect(actionState(state, 'remove')).toEqual({ disabled: false, label: 'Submit' })
    expect(gateMessage(state)).toBe(
      "No liquidity providers yet. Add liquidity to set this pool's price; swaps stay disabled until then.",
    )
  })

  it('keeps withdrawals open under maintenance and during a pending transaction', () => {
    expect(actionState({ ...OPEN, tradingEnabled: false }, 'swap')).toEqual({
      disabled: true,
      label: 'Under maintenance',
    })
    expect(actionState({ ...OPEN, tradingEnabled: false }, 'add')).toEqual({
      disabled: true,
      label: 'Under maintenance',
    })
    expect(actionState({ ...OPEN, tradingEnabled: false }, 'remove')).toEqual({
      disabled: false,
      label: 'Submit',
    })
    expect(gateMessage({ ...OPEN, tradingEnabled: false })).toBe(
      'Swaps and deposits are down for maintenance. Withdrawals are open.',
    )
    expect(actionState({ ...OPEN, pendingTx: true }, 'remove')).toEqual({
      disabled: true,
      label: 'Submit',
    })
  })

  it('keeps withdrawals open on a legacy pool', () => {
    const state = { ...OPEN, legacy: true }
    expect(actionState(state, 'swap')).toEqual({ disabled: true, label: 'Legacy' })
    expect(actionState(state, 'add')).toEqual({ disabled: true, label: 'Legacy' })
    expect(actionState(state, 'remove')).toEqual({ disabled: false, label: 'Submit' })
    expect(gateMessage(state)).toBe(
      'Legacy pool. This version is no longer supported; withdrawals only.',
    )
  })

  it('names the registry check before the registry has answered', () => {
    expect(actionState({ ...OPEN, listed: null }, 'swap')).toEqual({
      disabled: true,
      label: 'Checking registry…',
    })
    expect(gateMessage({ ...OPEN, listed: null })).toBe(
      'Checking this pool against the chain registry…',
    )
    expect(actionState({ ...OPEN, listed: false }, 'add')).toEqual({
      disabled: true,
      label: 'Not listed',
    })
    expect(gateMessage({ ...OPEN, listed: false })).toBe(
      'This pool is not listed in the chain registry. Trading is disabled; open a listed pool.',
    )
  })

  it('reports a failed verification instead of calling the pool unlisted', () => {
    const state = { ...OPEN, listed: null, unverified: true }
    for (const action of ['swap', 'add', 'remove'] as const) {
      expect(actionState(state, action)).toEqual({ disabled: true, label: 'Unverified' })
    }
    expect(gateMessage(state)).toBe(
      'This pool could not be verified against the chain registry. Reload the page to try again.',
    )
  })

  it('asks for a wallet before anything else can happen', () => {
    const state = { ...OPEN, connected: false }
    expect(actionState(state, 'swap')).toEqual({ disabled: true, label: 'Connect wallet to act' })
    expect(gateMessage(state)).toBe('Login to act on this pool.')
  })

  it('refuses a pool that cannot price notes', () => {
    const state = { ...OPEN, hasFees: false }
    expect(actionState(state, 'swap')).toEqual({ disabled: true, label: 'Trading disabled' })
    expect(gateMessage(state)).toBe(
      'Trading is disabled for this pool: it was imported without its fee faucet id.',
    )
  })

  it('reports a form error instead of submitting', () => {
    expect(actionState({ ...OPEN, formError: true }, 'add')).toEqual({
      disabled: true,
      label: 'Fix the amount first',
    })
  })
})
