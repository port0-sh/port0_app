/**
 * Per-page chrome shared by every entry point: the footer copyright year and
 * the one-time testnet disclaimer. Each page module calls `mountSiteChrome()`
 * next to `mountWallet()`.
 *
 * The disclaimer is remembered in localStorage once it is dismissed, by any
 * path (the accept button, the close button, or Escape). The testnet and
 * real-money notice is shown before the user can reach any action.
 */

import { mountBrand } from './brand'
import { CONFIG } from './config'
import { el } from './dom'
import { openModal } from '../ui/modal'

const DISCLAIMER_KEY = 'miden-xyk-app:testnet-disclaimer:v1'

/** Where the chart library's attribution links to. */
const TRADINGVIEW_URL = 'https://www.tradingview.com/'

export function mountSiteChrome(): void {
  mountBrand()
  setFooterYear()
  setChartAttribution()
  mountDisclaimer()
}

/**
 * Adds the chart library's attribution to the footer.
 *
 * `lightweight-charts` is Apache-2.0, Copyright 2023 TradingView, Inc. Its
 * licence requires an attribution notice and a link to tradingview.com; the
 * in-panel logo is only one way to satisfy that, and a page-wide link is the
 * other. This link is what allows `attributionLogo: false`.
 */
function setChartAttribution(): void {
  const footer = document.querySelector('.footer')
  if (!footer || footer.querySelector('.attribution')) return
  footer.append(
    el(
      'span',
      { class: 'attribution' },
      ' · Charts by ',
      el('a', { href: TRADINGVIEW_URL, rel: 'noopener', target: '_blank' }, 'TradingView'),
    ),
  )
}

function setFooterYear(): void {
  const year = document.getElementById('footer-year')
  if (year) year.textContent = String(new Date().getFullYear())
  const brand = document.getElementById('footer-brand')
  if (brand) brand.textContent = CONFIG.brand.name
}

function mountDisclaimer(): void {
  try {
    if (localStorage.getItem(DISCLAIMER_KEY) === '1') return
  } catch {
    // Storage unavailable: show the notice on every load rather than hide it.
  }

  const remember = (): void => {
    try {
      localStorage.setItem(DISCLAIMER_KEY, '1')
    } catch {
      // Storage unavailable: the notice simply reappears next load.
    }
  }

  let handle: { close: () => void } | null = null
  const accept = el(
    'button',
    { class: 'btn btn-primary', type: 'button', onclick: () => handle?.close() },
    'I understand',
  )
  const body = el(
    'div',
    {},
    el(
      'p',
      { class: 'error' },
      'Testnet only. These are test tokens, not real money.',
    ),
    el(
      'p',
      {},
      'MidenXYK runs on the Miden testnet. Tokens have no value, the network can be reset, and pools and balances can disappear.',
    ),
    el(
      'p',
      {},
      'The app and the contracts are a work in progress. Interfaces, contracts, and fees can change without notice.',
    ),
    el(
      'p',
      {},
      'Do not send mainnet assets. There is no mainnet deployment. Nothing here is financial advice.',
    ),
  )
  handle = openModal('Before you continue', body, accept, remember)
}
