import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'
import { decoratorPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

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
    plugins: [decoratorPlugin()],
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
    noExternal: [/^@deepseek-ai\//u, /^yaml(?:\/|$)/u, /^tar(?:\/|$)/u],
    plugins: [decoratorPlugin()],
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
    outputOptions: { polyfillRequire: false },
    banner: {
      js: `import { createRequire as createBuiltinRequire, isBuiltin } from 'node:module';
const builtinRequire = createBuiltinRequire(process.execPath);
const require = (specifier) => {
  if (!isBuiltin(specifier)) throw new Error('Windows startup only loads bundled dependencies and Node builtins');
  return builtinRequire(specifier);
};`,
    },
    noExternal: [/^@deepseek-ai\//u, /^yaml(?:\/|$)/u, /^adm-zip(?:\/|$)/u],
    plugins: [decoratorPlugin()],
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
    plugins: [decoratorPlugin()],
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
    plugins: [decoratorPlugin()],
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
    plugins: [decoratorPlugin()],
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
    noExternal: [/^@deepseek-ai\/(?:dsh-host-control-protocol|dsh-brand)(?:\/|$)/u],
    codeSplitting: false,
    plugins: [decoratorPlugin()],
  },
])
