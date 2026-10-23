import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'node:path'

// MPA build: one real HTML entry per page, no client-side router.
// Every entry points at its own module under src/pages/.
//
// Miden notes (vs @miden-sdk/vite-plugin, which peers on Vite 5/6 while this
// app pins Vite 8):
// - build.target 'esnext' for top-level await in the WASM entry points
// - the SDK and its WASM are excluded from dev pre-bundling
/** Networks the app knows; `src/lib/config.ts` holds their defaults. */
const NETWORKS = ['testnet', 'devnet', 'localnet', 'mainnet']

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
