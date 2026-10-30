import { defineConfig, loadEnv, transformWithOxc, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loaderMarkup } from './src/ui/spinner.ts'

// MPA build: one real HTML entry per page, no client-side router.
// Every entry points at its own module under src/pages/.
//
// Miden notes (vs @miden-sdk/vite-plugin, which peers on Vite 5/6 while this
// app pins Vite 8):
// - build.target 'esnext' for top-level await in the WASM entry points
// - the SDK and its WASM are excluded from dev pre-bundling
/** Networks the app knows; `src/lib/config.ts` holds its defaults. */
const NETWORKS = ['testnet', 'devnet', 'localnet', 'mainnet']
// The debug harness ships to test networks only; the mainnet build omits it.
const BUILD_NETWORK = (
  process.env.VITE_NETWORK ??
  loadEnv('production', process.cwd(), 'VITE_').VITE_NETWORK ??
  'testnet'
)
  .trim()
  .toLowerCase()
const APP_PKG = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'))
const SDK_DEPENDENCY: string = APP_PKG.dependencies['@port0.sh/sdk']
// A local `file:` link has no version string; read the linked package instead, so
// the footer names the build under test rather than the path.
const SDK_VERSION: string = SDK_DEPENDENCY.startsWith('file:')
  ? JSON.parse(
      readFileSync(resolve(import.meta.dirname, SDK_DEPENDENCY.slice('file:'.length), 'package.json'), 'utf8'),
    ).version
  : SDK_DEPENDENCY

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

/**
 * The loader belongs to the document, not to a module. Every host marked
 * `data-loader-state` receives its frames, the loader's styles, and an inline
 * script that starts the water at parse time — an empty panel or a still frame
 * while the bundle loads is a defect. The module only ends the animation.
 */
function inlineLoader(): Plugin {
  const cssPath = resolve(import.meta.dirname, 'src/styles/loader.css')
  const modulePath = resolve(import.meta.dirname, 'src/ui/spinner.ts')
  const host = /<([a-z][\w-]*)([^>]*\sdata-loader-state="([^"]+)"[^>]*)><\/\1>/g
  let script = ''

  /**
   * `spinner.ts` compiled for a classic script: the type syntax is gone and the
   * export keywords are stripped, so the bootstrap calls the same functions the
   * module exports instead of a second copy of them.
   */
  const inlineScript = async (): Promise<string> => {
    if (script.length > 0) return script
    const { code } = await transformWithOxc(readFileSync(modulePath, 'utf8'), modulePath, {
      lang: 'ts',
    })
    script = `<script>(function(){${code.replace(/^export /gm, '')}\nstartDocumentLoaders();})();</script>`
    return script
  }

  return {
    name: 'port0-inline-loader',
    configureServer(server) {
      server.watcher.add([cssPath, modulePath])
    },
    handleHotUpdate({ file, server }) {
      if (file !== cssPath && file !== modulePath) return
      script = ''
      server.ws.send({ type: 'full-reload' })
      return []
    },
    async transformIndexHtml(html) {
      let injected = false
      let out = html.replace(host, (_whole, tag: string, attrs: string, state: string) => {
        injected = true
        const detail = /\sdata-loader-detail="([^"]*)"/.exec(attrs)?.[1]
        return `<${tag}${attrs}>${loaderMarkup(state, detail)}</${tag}>`
      })
      if (!injected) {
        if (html.includes('data-loader-state')) {
          throw new Error('inline-loader: a loader host must be an empty element')
        }
        return html
      }
      const style = readFileSync(cssPath, 'utf8')
      const tag = await inlineScript()
      out = out.replace('</head>', () => `<style>\n${style}</style>\n</head>`)
      out = out.replace('</body>', () => `${tag}\n</body>`)
      return out
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
    inlineLoader(),
    inlineStaticContent(),
    {
      // Provenance: the bundle states which SDK build it was made from. The
      // release checklist compares this with the preflight's GENERATED_AT, so an
      // app built before the SDK was regenerated cannot ship silently.
      name: 'port0-sdk-provenance',
      // Build-only: `emitFile` has no meaning in the dev server.
      apply: 'build',
      async buildStart() {
        const sdk = await import('@port0.sh/sdk')
        const info = {
          sdk: SDK_VERSION,
          generatedAt: sdk.GENERATED_AT,
          contracts: sdk.CONTRACT_SHA256,
        }
        console.log(`sdk ${info.sdk} generated ${info.generatedAt} pool ${info.contracts.pool}`)
        this.emitFile({
          type: 'asset',
          fileName: 'build-info.json',
          source: JSON.stringify(info, null, 2),
        })
      },
    },
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
  define: {
    __APP_VERSION__: JSON.stringify(APP_PKG.version),
    __SDK_VERSION__: JSON.stringify(SDK_VERSION),
  },
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
        ...(BUILD_NETWORK === 'mainnet'
          ? {}
          : { debug: resolve(import.meta.dirname, 'debug.html') }),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@miden-sdk/miden-sdk', '@port0.sh/sdk'],
  },
})
