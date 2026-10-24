/**
 * The home page hero is static markup, inlined by `vite.config.ts` from
 * `src/assets/branding/hero.html`; the header mark and the brand text are
 * inlined there too. This module only rebuilds the banner's scroll extent after
 * aahub_light replaces the font's fallback face.
 */

/**
 * iOS WebKit keeps the fallback grid's width in the scroller after the swap,
 * which leaves the drawing clipped until the page is scrolled. The scroller is
 * rebuilt within one task, so no intermediate frame is painted.
 */
export function settleBannerFont(): void {
  const host = document.getElementById('site-banner')
  if (!host?.querySelector('.banner-source')) return
  void document.fonts.load('14px "aahub_light"').then(() => {
    host.style.overflowX = 'hidden'
    void host.offsetWidth
    host.style.overflowX = ''
  })
}
