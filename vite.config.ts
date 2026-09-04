// module 8.1  vite.config.ts -- builds frontend/ into public/, which express.static serves

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'frontend',

  // Vite's own static-asset directory, which it would resolve to frontend/public and copy
  // into the output verbatim. There is no such folder, and the name collides with the
  // build output below, which is a different thing entirely. Off, so it cannot be read as
  // the same idea twice.
  publicDir: false,

  plugins: [react()],

  build: {
    // Resolved against `root`, so this is the repository's public/ -- the directory
    // app/server.ts hands to express.static. There is no dev server and no proxy: the
    // dashboard is served by wirehttp, on wirehttp's own origin, or it is not served.
    outDir: '../public',

    // Vite's emptying spares .git and nothing else, so it would delete public/.gitkeep and
    // leave a tracked file missing after every build. Nothing accumulates here regardless:
    // the stable output names below mean each build overwrites the same files.
    emptyOutDir: false,

    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
