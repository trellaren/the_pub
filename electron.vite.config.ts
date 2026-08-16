import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared, '@main': resolve('src/main') } },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // Sandboxed preload scripts are evaluated as CommonJS. The package is
        // ESM ("type": "module"), so the .cjs extension is what tells Node to
        // treat this one file as CJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@shared': shared, '@renderer': resolve('src/renderer') } },
    plugins: [react(), tailwindcss()],
    // citeproc-plus ships its CSL style and locale catalog as gzip-compressed
    // JSON chunks, loaded with a dynamic `import()` at the URL Vite gives
    // them. Vite's default asset handling doesn't recognise `.json.gz`, so
    // without this the chunks fall through to the JS transform and the build
    // fails on them as invalid syntax.
    assetsInclude: ['**/*.gz'],
    // The dev server's dependency pre-bundler (esbuild) crawls citeproc-plus's
    // own dynamic imports of those `.gz` chunks to decide what to prebundle,
    // and esbuild — unlike Rollup — has no loader for `.gz` and has no
    // `assetsInclude` option to tell it to treat them as assets instead of
    // source. `npm run build`'s production Rollup build already handles this
    // correctly via `assetsInclude` above; excluding the package from
    // pre-bundling keeps `npm run dev` from ever handing those files to
    // esbuild in the first place.
    optimizeDeps: { exclude: ['citeproc-plus'] },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // Dockview opens popout groups at this same-origin page.
          popout: resolve('src/renderer/popout.html')
        }
      }
    }
  }
})
