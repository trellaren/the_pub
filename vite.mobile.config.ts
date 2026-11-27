import { defineConfig, type AliasOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const shim = (name: string): string => resolve('src/mobile/host/shims', `${name}.ts`)
const unavailable = shim('unavailable')

/*
 * The iOS build is the renderer plus the desktop main process's services,
 * bundled for a WebView. Those services are written against Node and Electron;
 * each module they import is answered here by a stand-in with the same shape,
 * so the services themselves are shared rather than forked.
 */
const alias: AliasOptions = [
  { find: '@shared', replacement: resolve('src/shared') },
  { find: '@renderer', replacement: resolve('src/renderer') },
  { find: '@main', replacement: resolve('src/main') },
  { find: 'electron', replacement: shim('electron') },
  { find: 'node:fs/promises', replacement: shim('fsPromises') },
  { find: 'node:fs', replacement: shim('fs') },
  { find: 'node:path', replacement: shim('path') },
  { find: 'node:crypto', replacement: shim('crypto') },
  { find: 'node:os', replacement: shim('os') },
  { find: 'node:url', replacement: shim('url') },
  { find: 'node:dns/promises', replacement: shim('dns') },
  { find: 'node:sqlite', replacement: shim('sqlite') },
  { find: 'node:async_hooks', replacement: shim('asyncHooks') },
  { find: 'chokidar', replacement: shim('chokidar') },
  ...['node:net', 'node:http', 'node:stream', 'node:child_process', 'ssh2', 'basic-ftp', 'pg', 'mysql2/promise'].map(
    (find) => ({ find, replacement: unavailable })
  )
]

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  root: 'src/mobile',
  // Capacitor serves the bundle from a custom scheme, where an absolute `/assets/…` has no host to be absolute against.
  base: './',
  resolve: { alias },
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  assetsInclude: ['**/*.gz'],
  optimizeDeps: { exclude: ['citeproc-plus', '@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  build: {
    outDir: resolve('dist/mobile'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: { index: resolve('src/mobile/index.html') } }
  }
})
