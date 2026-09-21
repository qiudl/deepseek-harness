import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'
// Static package inspection imports this config before generated JS exists.
// Load the compiled generator only when the bundler actually invokes its hooks.
function deferredTypertPlugin() {
  let plugin: Promise<ReturnType<typeof import('../../typert/generator/src/tsdown-plugin.ts').typertPlugin>> | undefined
  const load = () => plugin ??= import('../../typert/generator/lib/types/tsdown-plugin.js')
    .then(({ typertPlugin }) => typertPlugin({ mode: 'package', faces: ['host'] }))
  return {
    name: 'dsh-typert-generator',
    async transform(code: string, id: string) { return (await load()).transform(code, id) },
    async writeBundle(options: { dir?: string }) { (await load()).writeBundle(options) },
  }
}

/** Build Host authority entries plus the standalone Main-only client artifact. */
export default defineConfig([
  {
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    noExternal: [/^@deepseek-ai\//u, /^yaml(?:\/|$)/u],
    plugins: [deferredTypertPlugin()],
  },
  {
    entry: { startup: 'lib/types/startup.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    noExternal: [/^@deepseek-ai\//u, /^yaml(?:\/|$)/u],
    plugins: [deferredTypertPlugin()],
  },
  {
    entry: { 'windows-startup': 'lib/types/windows-startup.js' },
    // The verified startup loads from a data URL; YAML's default ESM export avoids createRequire(import.meta.url).
    alias: { yaml: fileURLToPath(new URL('./node_modules/yaml/browser/index.js', import.meta.url)) },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    noExternal: [/^@deepseek-ai\//u, /^yaml(?:\/|$)/u],
  },
  {
    entry: { 'windows-host-pipe-worker-entry': 'lib/types/windows-host-pipe-worker-entry.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    noExternal: [/^@deepseek-ai\//u],
  },
  {
    entry: { 'windows-host-client-worker-entry': 'lib/types/windows-host-client-worker-entry.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    noExternal: [/^@deepseek-ai\//u],
  },
  {
    entry: { 'windows-embedding-identity-entry': 'lib/types/windows-embedding-identity-entry.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    noExternal: [/^@deepseek-ai\//u],
  },
  {
    entry: { 'host-control-client': 'lib/types/client.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    noExternal: [/^@deepseek-ai\/dsh-host-control-protocol(?:\/|$)/u],
    codeSplitting: false,
  },
])
