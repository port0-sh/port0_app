/**
 * Shared by every entry point: the footer copyright year, the alpha notice, and
 * the sound control. The social links, legal links, and chart attribution are
 * static footer markup. Each page module calls `mountSite()` next to
 * `mountWallet()`.
 *
 * The notice is markup, so it reads without JavaScript, and it sits above the
 * header rather than over the page. On testnet the bar is dismissible; on
 * mainnet it is permanent and the first visit is gated by a modal. Acceptance
 * is recorded under a per-network key that the inline script in each page head
 * reads before the first paint of a later visit, so the bar never flashes back.
 */

import { settleBannerFont } from './brand'
import { CONFIG } from './config'
import { el } from './dom'
import { playArrivalBell, setSoundEnabled, soundEnabled } from './sound'

export function mountSite(): void {
  settleBannerFont()
  setFooterYear()
  mountNotice()
  mountSoundToggle()
}

/**
 * Wires the static arrival-bell button that ships in the markup. The preference
 * is one `localStorage` key, and turning the bell on rings it once so the choice
 * is audible.
 */
function mountSoundToggle(): void {
  const button = document.getElementById('sound-toggle')
  if (!(button instanceof HTMLButtonElement)) return
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
}

function setFooterYear(): void {
  const year = document.getElementById('footer-year')
  if (year) year.textContent = String(new Date().getFullYear())
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
