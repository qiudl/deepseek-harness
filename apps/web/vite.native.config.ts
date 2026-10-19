/** App-bundled, isolated edition of the same Web entry. Contains no account or Host data. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import base from './vite.config.ts'
import { inlineNativePage } from './native-document.ts'

function inlineNativeDocument(): Plugin {
  let directory = ''
  return {
    name: 'dsh-inline-native-document',
    configResolved(config) {
      if (config.mode !== 'native') throw Error('native document requires --mode native')
      directory = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      const path = resolve(directory, 'native.html')
      const html = await inlineNativePage(await readFile(path, 'utf8'), asset => readFile(resolve(directory, asset), 'utf8'))
      await writeFile(path, html)
    },
  }
}

export default defineConfig({
  ...base,
  plugins: [react(), inlineNativeDocument()],
  publicDir: false,
  build: {
    target: 'es2022', outDir: 'dist-native', sourcemap: false,
    assetsInlineLimit: 64 * 1024 * 1024, cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./native.html', import.meta.url)),
      output: { inlineDynamicImports: true },
    },
  },
})
