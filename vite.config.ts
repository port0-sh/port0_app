import { defineConfig, loadEnv, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// MPA build: one real HTML entry per page, no client-side router.
// Every entry points at its own module under src/pages/.
//
// Miden notes (vs @miden-sdk/vite-plugin, which peers on Vite 5/6 while this
// app pins Vite 8):
// - build.target 'esnext' for top-level await in the WASM entry points
// - the SDK and its WASM are excluded from dev pre-bundling
/** Networks the app knows; `src/lib/config.ts` holds its defaults. */
const NETWORKS = ['testnet', 'devnet', 'localnet', 'mainnet']

/**
 * Static site content is inlined at build time: the hand-edited drawings, the
 * footer links, and the brand text. The served page then paints without waiting
 * for a module, and a deployment still changes each piece by editing one file or
 * one env var.
 */
function inlineStaticContent(): Plugin {
  const heroPath = resolve(import.meta.dirname, 'src/assets/branding/hero.html')
  const logoPath = resolve(import.meta.dirname, 'src/assets/branding/logo.html')
  const footerPath = resolve(import.meta.dirname, 'src/assets/site/footer.html')
  const bannerPlaceholder = '<div id="site-banner" hidden></div>'
  const markPlaceholder = '<img class="brand-mark" src="/mark.svg" alt="" />'
  const namePlaceholder = '<span class="brand-name">%VITE_BRAND_NAME%</span>'
  const sloganPlaceholder = '<p class="brand-slogan" id="brand-slogan" hidden></p>'

  let logoText = ''
  let slogan = ''

  return {
    name: 'port0-inline-static',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, 'VITE_')
      logoText = (env.VITE_BRAND_LOGO_TEXT ?? '').trim()
      slogan = (env.VITE_BRAND_SLOGAN ?? '').trim()
    },
    configureServer(server) {
      server.watcher.add([heroPath, logoPath, footerPath])
    },
    handleHotUpdate({ file, server }) {
      if (file !== heroPath && file !== logoPath && file !== footerPath) return
      server.ws.send({ type: 'full-reload' })
      return []
    },
    transformIndexHtml: {
      // Before Vite replaces `%VITE_*%`, so the brand text can use the env here.
      order: 'pre',
      handler(html) {
        let out = html

        if (out.includes('id="site-banner"')) {
          if (!out.includes(bannerPlaceholder)) {
            throw new Error('inline-static: #site-banner placeholder not found')
          }
          const hero = readFileSync(heroPath, 'utf8')
          const drawing = hero.trim().length > 0 ? hero : readFileSync(logoPath, 'utf8')
          out = out.replace(bannerPlaceholder, () => `<div id="site-banner">${drawing}</div>`)
        }

        const logo = readFileSync(logoPath, 'utf8').trimEnd()
        if (logo.length > 0) {
          out = out.replaceAll(markPlaceholder, () => logo)
        }
        if (logoText.length > 0) {
          out = out.replaceAll(namePlaceholder, () => `<span class="brand-name">${logoText}</span>`)
        }
        if (slogan.length > 0) {
          out = out.replaceAll(
            sloganPlaceholder,
            () => `<p class="brand-slogan" id="brand-slogan">${slogan}</p>`,
          )
        }

        if (out.includes('</footer>')) {
          const footer = readFileSync(footerPath, 'utf8').trimEnd()
          if (footer.length === 0) {
            throw new Error('inline-static: footer fragment is empty')
          }
          out = out.replace('</footer>', () => `\n${footer}\n  </footer>`)
        }

        return out
      },
    },
  }
}

export default defineConfig({
  envPrefix: ['VITE_'],
  resolve: {
    // The miden vite plugin dedupes the WASM SDK so the app and @port0.sh/sdk
    // share one instance; replicate that with Vite 8 (the plugin peers on
    // Vite 5/6). Without it, objects from one copy fail instanceof checks in
    // the other ("expected instance of X").
    dedupe: ['@miden-sdk/miden-sdk'],
  },
  plugins: [
    inlineStaticContent(),
    {
      // An unrecognised VITE_NETWORK would otherwise embed a build that only
      // fails when a browser loads it. Fail the build instead.
      name: 'port0-validate-network',
      config(_, { mode }) {
        // `loadEnv` is what reads `.env`; `process.env` would miss it and let a
        // typo through to a runtime failure in the browser.
        const env = loadEnv(mode, process.cwd(), 'VITE_')
        const requested = (env.VITE_NETWORK ?? 'testnet').trim().toLowerCase()
        if (!NETWORKS.includes(requested)) {
          throw new Error(
            `VITE_NETWORK="${requested}" is not a known network; expected one of ${NETWORKS.join(', ')}`,
          )
        }
      },
    },
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        pool: resolve(import.meta.dirname, 'pool.html'),
        create: resolve(import.meta.dirname, 'create.html'),
        about: resolve(import.meta.dirname, 'about.html'),
        media: resolve(import.meta.dirname, 'media.html'),
        utils: resolve(import.meta.dirname, 'utils.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@miden-sdk/miden-sdk', '@port0.sh/sdk'],
  },
})
