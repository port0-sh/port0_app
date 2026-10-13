/**
 * Per-page chrome shared by every entry point: the footer copyright year, the
 * chart attribution, and the testnet notice. Each page module calls
 * `mountSiteChrome()` next to `mountWallet()`.
 *
 * The notice is markup, so it reads without JavaScript, and it sits above the
 * header rather than over the page. Dismissing it sets the flag named by
 * `<html data-notice-key>`; the inline script in the page head reads that flag
 * before the first paint of a later visit, so it never flashes back.
 */

import { mountBrand } from './brand'
import { CONFIG } from './config'
import { el } from './dom'

/** Where the chart library's attribution links to. */
const TRADINGVIEW_URL = 'https://www.tradingview.com/'

/** Social handles. Declared once; every page footer follows. */
const SOCIALS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'X', href: 'https://x.com/port0_sh' },
  { label: 'Telegram', href: 'https://t.me/port0_sh' },
  { label: 'GitHub', href: 'https://github.com/port0-sh' },
]

export function mountSiteChrome(): void {
  mountBrand()
  setFooterYear()
  setFooterSocials()
  setChartAttribution()
  mountNotice()
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

/** Appends the social links to the footer, once per page. */
function setFooterSocials(): void {
  const footer = document.querySelector('.footer')
  if (!footer || footer.querySelector('.socials')) return
  const wrap = el('span', { class: 'socials' })
  for (const { label, href } of SOCIALS) {
    wrap.append(' · ', el('a', { href, rel: 'noopener', target: '_blank' }, label))
  }
  footer.append(wrap)
}

function setFooterYear(): void {
  const year = document.getElementById('footer-year')
  if (year) year.textContent = String(new Date().getFullYear())
  const brand = document.getElementById('footer-brand')
  if (brand) brand.textContent = CONFIG.brand.name
}

/**
 * Wires the testnet notice's dismiss button.
 *
 * The key has one name in one place, the page's `<html data-notice-key>`, which
 * the head script reads as well. A browser that has no storage, or refuses it,
 * keeps the notice visible: the failing direction is the safe one.
 */
function mountNotice(): void {
  const notice = document.getElementById('testnet-notice')
  const dismiss = notice?.querySelector<HTMLButtonElement>('#notice-dismiss')
  if (!notice || !dismiss) return

  dismiss.addEventListener('click', () => {
    try {
      const key = document.documentElement.dataset.noticeKey
      if (key) localStorage.setItem(key, '1')
    } catch {
      // Storage unavailable: the notice reappears next load rather than hiding.
    }
    document.documentElement.dataset.notice = 'dismissed'
  })
}
