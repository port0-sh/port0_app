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
import { openOneTimeMint } from '../features/oneTimeMint'
import { openSendPublicNote } from '../features/sendPublicNote'
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

  let closeOpenMenu: (() => void) | null = null

  walletStore.subscribe(render)

  // Re-attach a previously saved wallet session; no user interaction
  // required unless the wallet locked in the meantime.
  void restoreSession().catch(() => {})

  function render(): void {
    closeOpenMenu?.()
    closeOpenMenu = null
    clear(root as HTMLElement)
    const state = walletStore.get()

    if (state.connected && state.address) {
      root!.append(accountControl(state.address))
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

  /**
   * The signed-in control: the account id plus a menu holding the utilities and
   * disconnect. The menu closes on an outside click or Escape.
   */
  function accountControl(address: string): HTMLElement {
    const menu = el(
      'div',
      { class: 'menu', role: 'menu', hidden: true },
      el('p', { class: 'menu-label' }, 'Utils'),
      el(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            close()
            openOneTimeMint()
          },
        },
        'One-time mint',
      ),
      el(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            close()
            openSendPublicNote()
          },
        },
        'Send public note',
      ),
      el('hr', { class: 'menu-rule' }),
      el(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            close()
            void disconnect().catch(() => {})
          },
        },
        'Disconnect',
      ),
    )
    const trigger = el(
      'button',
      {
        class: 'btn account-btn',
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        onclick: () => {
          if (menu.hidden) open()
          else close()
        },
      },
      el('span', { class: 'account-glyph', 'aria-hidden': 'true' }, '☻'),
      el('span', { class: 'mono', title: address }, shortAddress(address)),
      el('span', { class: 'account-caret', 'aria-hidden': 'true' }, '▾'),
    )
    const wrapper = el('div', { class: 'account' }, trigger, menu)

    function onOutside(event: PointerEvent): void {
      if (!wrapper.contains(event.target as Node)) close()
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close()
    }

    function open(): void {
      menu.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      document.addEventListener('pointerdown', onOutside, true)
      document.addEventListener('keydown', onKey)
      closeOpenMenu = close
    }

    function close(): void {
      menu.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey)
      closeOpenMenu = null
    }

    return wrapper
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

  // Bootstrap last. render() reads `closeOpenMenu`, so calling it above the
  // declaration would throw `Cannot access ... before initialization` and leave
  // the page shell on screen forever.
  render()
}
