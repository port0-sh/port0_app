import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// MPA build: one real HTML entry per page, no client-side router.
// Every entry points at its own module under src/pages/.
//
// Miden notes (vs @miden-sdk/vite-plugin, which peers on Vite 5/6 while this
// app pins Vite 8):
// - build.target 'esnext' for top-level await in the WASM entry points
// - the SDK and its WASM are excluded from dev pre-bundling
export default defineConfig({
  envPrefix: ['VITE_'],
  resolve: {
    // The miden vite plugin dedupes the WASM SDK so the app and @port0.sh/sdk
    // share one instance; replicate that with Vite 8 (the plugin peers on
    // Vite 5/6). Without it, objects from one copy fail instanceof checks in
    // the other ("expected instance of X").
    dedupe: ['@miden-sdk/miden-sdk'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        pool: resolve(import.meta.dirname, 'pool.html'),
        create: resolve(import.meta.dirname, 'create.html'),
        about: resolve(import.meta.dirname, 'about.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@miden-sdk/miden-sdk', '@port0.sh/sdk'],
  },
})
