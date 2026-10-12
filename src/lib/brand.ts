/**
 * Branding.
 *
 * MidenXYK is the library; a deployment is a platform with its own name, mark,
 * and artwork. The name, the text mark, and the slogan come from configuration.
 * The two drawings come from files meant to be edited by hand:
 *
 *   src/assets/branding/hero.html   the home page hero
 *   src/assets/branding/logo.html   the mark in the header of the other pages
 *
 * A deployment overrides either one by adding a second file beside it, named
 * `<slot>.<override>.html`, and setting `VITE_BRAND_OVERRIDE` to that override.
 * With `VITE_BRAND_OVERRIDE=local`, `hero.local.html` wins over `hero.html`.
 * Override names match `*.local.html`, which `.gitignore` excludes.
 *
 * Both files are inserted as they stand: nothing here parses, splits, or
 * reassembles a drawing, and a drawing carries its own `<style>` when it needs
 * motion of its own.
 */

import { CONFIG } from './config'

/** Lazy, so a page fetches only the drawing it shows. */
const drawings = import.meta.glob('../assets/branding/*.html', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

/** Override flavour selected by `VITE_BRAND_OVERRIDE`; empty uses the shipped file. */
const OVERRIDE = (import.meta.env.VITE_BRAND_OVERRIDE ?? '').trim()

/** Renders the brand slots a page provides: the hero, the mark, the heading. */
export function mountBrand(): void {
  renderHeading()
  void renderLogo()
  void renderHero()
}

/** Fills the home page's name and slogan when the page provides slots for them. */
function renderHeading(): void {
  const heading = document.getElementById('brand-heading')
  if (heading) heading.textContent = CONFIG.brand.name
  const slogan = document.getElementById('brand-slogan')
  if (!slogan) return
  slogan.textContent = CONFIG.brand.slogan
  slogan.hidden = CONFIG.brand.slogan.length === 0
}

/**
 * Replaces the header mark with `logo.html` when the deployment ships one. An
 * empty file leaves the markup the page shipped with, so a header never depends
 * on JavaScript to appear.
 */
async function renderLogo(): Promise<void> {
  const host = document.querySelector<HTMLElement>('.brand')
  const mark = host?.querySelector('.brand-mark')
  const name = host?.querySelector('.brand-name')
  if (!host || !mark || !name) return

  const html = await load('logo')
  if (html.trim().length > 0) mark.replaceWith(...fragment(html))
  name.textContent = CONFIG.brand.logoText || CONFIG.brand.name
  host.setAttribute('aria-label', CONFIG.brand.name)
}

/**
 * Fills `#site-banner` with `hero.html`, or with the logo when the hero is
 * empty, so a deployment that ships no hero still shows a mark.
 */
async function renderHero(): Promise<void> {
  const host = document.querySelector<HTMLElement>('#site-banner')
  if (!host) return
  const hero = await load('hero')
  const html = hero.trim().length > 0 ? hero : await load('logo')
  host.innerHTML = html
  host.hidden = html.trim().length === 0
}

/** Raw text of a drawing slot, empty when the deployment ships none. */
async function load(slot: 'hero' | 'logo'): Promise<string> {
  const override = OVERRIDE.length > 0 ? `${slot}.${OVERRIDE}.html` : ''
  const loader =
    (override ? drawings[`../assets/branding/${override}`] : undefined) ??
    drawings[`../assets/branding/${slot}.html`]
  return loader ? await loader() : ''
}

/** The nodes of a markup fragment, without a wrapper element. */
function fragment(html: string): Node[] {
  const template = document.createElement('template')
  template.innerHTML = html
  return [...template.content.childNodes]
}
