/**
 * Branding.
 *
 * MidenXYK is the library; a deployment is a platform with its own name, mark,
 * and artwork. Everything here comes from configuration or from a file meant to
 * be edited by hand, so a fork rebrands without touching application code.
 *
 * The banner is `src/assets/banners/finished.html`, injected as it stands. It is
 * authored markup, not generated: the `<pre class="banner-source">` it contains
 * carries the artwork and the `<span class="banner-swell">` runs that move, and
 * `src/styles/global.css` carries the motion. The module does not parse, split,
 * or reassemble the drawing.
 */

import finishedBanner from '../assets/banners/finished.html?raw'
import { CONFIG } from './config'
import { el } from './dom'

/** Renders the header mark, the page title, the banner, and the home heading. */
export function mountBrand(): void {
  setTitle()
  renderHeaderMark()
  renderBanner()
  renderPageHeading()
}

/**
 * Page title as `<page> — <brand>`. The page name comes from `data-page` on the
 * body, so the platform's name is not written into any page's markup.
 */
function setTitle(): void {
  const page = document.body.dataset.page
  if (!page) return
  document.title = `${page} — ${CONFIG.brand.name}`
}

/** Replaces the header mark with the configured image, text, or brand name. */
function renderHeaderMark(): void {
  const host = document.querySelector('.brand')
  const mark = host?.querySelector('.brand-mark')
  const name = host?.querySelector('.brand-name')
  if (!host || !mark || !name) return

  if (CONFIG.brand.logoImage.length > 0) {
    mark.replaceWith(
      el('img', {
        class: 'brand-logo',
        src: CONFIG.brand.logoImage,
        alt: '',
        width: 28,
        height: 28,
      }),
    )
  }
  name.textContent = CONFIG.brand.logoText || CONFIG.brand.name
  host.setAttribute('aria-label', CONFIG.brand.name)
}

/** Fills the home page's name and slogan when the page provides slots for them. */
function renderPageHeading(): void {
  const heading = document.getElementById('brand-heading')
  if (heading) heading.textContent = CONFIG.brand.name
  const slogan = document.getElementById('brand-slogan')
  if (!slogan) return
  slogan.textContent = CONFIG.brand.slogan
  slogan.hidden = CONFIG.brand.slogan.length === 0
}

/**
 * Fills `#site-banner` when a page provides one, with the banner file verbatim.
 *
 * The markup is a build-time asset of this repository, so it is inserted as
 * markup rather than text. Nothing here rewrites it.
 */
function renderBanner(): void {
  const host = document.querySelector<HTMLElement>('#site-banner')
  if (!host) return
  host.innerHTML = finishedBanner
  host.hidden = finishedBanner.trim().length === 0
}