/**
 * Wallet region in the page header: a Login button that opens a wallet
 * picker, or an address chip with a disconnect button once connected.
 * Mounted once per page from the page module.
 *
 * The pages also ship a static Login button inside #wallet (plain HTML), so
 * the control is visible before any module evaluates; render() replaces it
 * with the live version.
 */

import { WalletReadyState } from '@miden-sdk/miden-wallet-adapter-base'
import { CONFIG } from '../lib/config'
import { clear, el } from '../lib/dom'
import { shortAddress } from '../lib/format'
import { openModal } from '../ui/modal'
import { toast } from '../ui/toast'
import {
  connect,
  disconnect,
  getBreadWallet,
  restoreSession,
  walletStore,
  type WalletKind,
} from './wallet'

export function mountWallet(): void {
  const root = document.getElementById('wallet')
  if (!root) return

  render()
  walletStore.subscribe(render)

  // Re-attach a previously saved wallet session; no user interaction
  // required unless the wallet locked in the meantime.
  void restoreSession().catch(() => {})

  function render(): void {
    clear(root as HTMLElement)
    const state = walletStore.get()

    if (state.connected && state.address) {
      root!.append(
        el('span', { class: 'mono muted', title: state.address }, shortAddress(state.address)),
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              void disconnect().catch(() => {})
            },
          },
          'Disconnect',
        ),
      )
      return
    }

    root!.append(
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: openPicker,
          disabled: state.connecting,
        },
        state.connecting ? 'Connecting…' : 'Login',
      ),
    )
  }

  async function openPicker(): Promise<void> {
    // Ensures the adapter (and its readyState) is loaded before showing it.
    await getBreadWallet()
    const breadReady = walletStore.get().readyState === WalletReadyState.Installed
    const body = el(
      'div',
      { class: 'wallet-list' },
      el(
        'button',
        { class: 'btn wallet-option', type: 'button', onclick: () => void pick('bread') },
        el('span', {}, 'Bread Wallet'),
        el(
          'span',
          { class: 'muted' },
          breadReady ? 'installed' : 'not detected',
        ),
      ),
      el(
        'button',
        {
          class: 'btn wallet-option',
          type: 'button',
          disabled: true,
          title: CONFIG.paraApiKey
            ? 'Para login flow ships next'
            : 'Requires VITE_PARA_API_KEY (see .env.example)',
        },
        el('span', {}, 'Para Wallet'),
        el(
          'span',
          { class: 'muted' },
          CONFIG.paraApiKey ? 'wiring next' : 'needs API key',
        ),
      ),
    )
    const handle = openModal('Login', body)

    async function pick(kind: WalletKind): Promise<void> {
      try {
        await connect(kind)
        handle.close()
        toast('Wallet connected.')
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
    }
  }
}
