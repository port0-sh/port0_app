/**
 * Shared by every entry point: the footer copyright year, the social links,
 * the chart attribution, and the alpha notice. Each page module calls
 * `mountSite()` next to `mountWallet()`.
 *
 * The notice is markup, so it reads without JavaScript, and it sits above the
 * header rather than over the page. On testnet the bar is dismissible; on
 * mainnet it is permanent and the first visit is gated by a modal. Acceptance
 * is recorded under a per-network key that the inline script in each page head
 * reads before the first paint of a later visit, so the bar never flashes back.
 */

import { mountBrand } from './brand'
import { CONFIG } from './config'
import { el } from './dom'
import { playArrivalBell, setSoundEnabled, soundEnabled } from './sound'

/** Where the chart library's attribution links to. */
const TRADINGVIEW_URL = 'https://www.tradingview.com/'

/** Social handles. Declared once; every page footer follows. */
const SOCIALS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'X', href: 'https://x.com/port0_sh' },
  { label: 'Telegram', href: 'https://t.me/port0_sh' },
  { label: 'GitHub', href: 'https://github.com/port0-sh' },
]

/** Legal documents. Declared once; every page footer follows. */
const LEGAL: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Terms of Service', href: 'https://docs.port0.sh/legal/terms.html' },
  { label: 'Privacy Policy', href: 'https://docs.port0.sh/legal/privacy.html' },
]

export function mountSite(): void {
  mountBrand()
  setFooterYear()
  setFooterSocials()
  setFooterLegal()
  setChartAttribution()
  mountNotice()
  mountSoundToggle()
}

/**
 * The arrival bell's on/off button, in the menu row beside the wallet. The
 * preference is one `localStorage` key, and turning the bell on rings it once
 * so the choice is audible.
 */
function mountSoundToggle(): void {
  if (document.getElementById('sound-toggle')) return
  // The wallet control is in the menu row on the home page and in the site
  // header everywhere else. Both sit inside one flex cell with the button, so a
  // narrow viewport cannot auto-place the button on a row of its own.
  const wallet = document.getElementById('wallet')
  const parent = wallet?.parentElement
  if (!wallet || !parent) return
  const tools = el('div', { class: 'header-tools' })
  parent.insertBefore(tools, wallet)
  tools.append(wallet)
  const button = el('button', {
    type: 'button',
    class: 'btn sound-toggle',
    id: 'sound-toggle',
  })
  const render = (): void => {
    const on = soundEnabled()
    // The glyph alone: the word made the button wide enough to wrap the header.
    button.textContent = on ? '🔊' : '🔇'
    button.setAttribute('aria-pressed', String(on))
    button.setAttribute('aria-label', on ? 'Arrival bell on' : 'Arrival bell off')
    button.title = on ? 'Arrival bell on' : 'Arrival bell off'
  }
  button.addEventListener('click', () => {
    const on = !soundEnabled()
    setSoundEnabled(on)
    render()
    if (on) playArrivalBell()
  })
  render()
  tools.append(button)
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

/**
 * Appends the legal links to the footer, after the socials and before the
 * chart attribution.
 */
function setFooterLegal(): void {
  const footer = document.querySelector('.footer')
  if (!footer || footer.querySelector('.legal')) return
  const wrap = el('span', { class: 'legal' })
  for (const { label, href } of LEGAL) {
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

/** Acknowledgement key for the alpha notice, one per network. */
function alphaKey(): string {
  return `port0-app:alpha-risk:v1:${CONFIG.network}`
}

/** Whether this browser already accepted the alpha notice for this network. */
function alphaAccepted(): boolean {
  try {
    return localStorage.getItem(alphaKey()) === '1'
  } catch {
    return false
  }
}

/** Records acceptance and hides the notice bar. */
function acceptAlpha(): void {
  try {
    localStorage.setItem(alphaKey(), '1')
  } catch {
    // Storage unavailable: the gate reappears next load rather than disappearing.
  }
  document.documentElement.dataset.notice = 'dismissed'
}

/**
 * Wires the alpha notice and, on mainnet, the acknowledgement gate.
 *
 * On testnet the bar is dismissible. On mainnet the bar is permanent and a
 * first visit opens a modal that only the accept button closes: real funds are
 * at stake, and a click on the backdrop or the Esc key must not pass as
 * consent.
 */
function mountNotice(): void {
  const notice = document.getElementById('alpha-notice')
  const dismiss = notice?.querySelector<HTMLButtonElement>('#notice-dismiss')
  dismiss?.addEventListener('click', acceptAlpha)

  if (CONFIG.realFunds && !alphaAccepted()) mountAlphaGate()
}

/** Opens the mainnet acknowledgement modal. */
function mountAlphaGate(): void {
  // `closedby="none"` is the standard way to disable light dismiss (Esc and
  // backdrop). The cancel listener below is the fallback for browsers that do
  // not implement the attribute, and headless Chromium does not honour it.
  const dialog = el('dialog', { class: 'modal alpha-gate', closedby: 'none' })

  const accept = el(
    'button',
    { type: 'button', class: 'btn btn-primary', id: 'alpha-accept' },
    'I accept the Terms',
  )
  accept.addEventListener('click', () => {
    acceptAlpha()
    if (dialog.open) dialog.close()
    dialog.remove()
  })

  dialog.append(
    el('h2', {}, 'Closed alpha: real funds'),
    el(
      'p',
      {},
      `${CONFIG.brand.name} runs on the Miden partner mainnet. The software is experimental and unaudited.`,
    ),
    el(
      'ul',
      {},
      el(
        'li',
        {},
        'You can lose every fund you deposit. Transactions are irreversible: no refund, no chargeback, no recovery of lost keys.',
      ),
      el(
        'li',
        {},
        `The software is provided as is, without warranty. To the maximum extent permitted by law, ${CONFIG.brand.name} and its contributors are not liable for any loss you suffer.`,
      ),
      el(
        'li',
        {},
        'Listing is permissionless. The registry vets no token: a listed token can be worthless or mintable without limit by its creator.',
      ),
      el('li', {}, 'Nothing here is financial, investment, legal, or tax advice.'),
    ),
    el(
      'p',
      {},
      'By continuing you accept the ',
      el(
        'a',
        { href: 'https://docs.port0.sh/legal/terms.html', target: '_blank', rel: 'noopener' },
        'Terms of Service',
      ),
      ', including the assumption of risk and the limitation of liability, and you '
        + 'acknowledge the ',
      el(
        'a',
        { href: 'https://docs.port0.sh/legal/privacy.html', target: '_blank', rel: 'noopener' },
        'Privacy Policy',
      ),
      '.',
    ),
    el('div', { class: 'form-actions' }, accept),
  )

  // Esc must not dismiss the gate; the accept button is the only exit.
  // `cancel` is cancelable, so preventing it stops the close where the browser
  // honours that; `closedby="none"` covers the rest.
  dialog.addEventListener('cancel', (event) => event.preventDefault())

  document.body.append(dialog)
  dialog.showModal()
}
