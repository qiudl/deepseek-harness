import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { create } from 'tar'
import { BundledPluginCatalog } from '../../src/bundled-plugins.ts'

/**
 * Create the released archive / ordinary node_modules layout.
 * @param root - test-owned root. @param web - existing composition directory.
 * @param name - installed dependency identity.
 * @returns trusted catalog and generated fixture paths.
 */
export async function bundledRecoveryFixture(root: string, web: string, name = '@fixture/plugin') {
  const embedding = join(root, 'embedding')
  const packed = join(root, 'packed')
  const installed = join(web, 'node_modules', name)
  const files = {
    'package.json': JSON.stringify({ name, version: '1.0.0', type: 'module' }),
    'lib/index.js': 'export const plugin = true\n',
    'node_modules/child/index.js': 'export const child = true\n',
  }
  for (const [path, content] of Object.entries(files)) {
    for (const directory of [join(packed, 'package'), installed]) {
      const file = join(directory, path)
      await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
      await writeFile(file, content, { mode: 0o600 })
    }
  }
  const archive = await create({ gzip: true, cwd: packed }, Object.keys(files).map(path => 'package/' + path)).concat()
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const row = { name, version: '1.0.0', file: 'fixture.tgz', sha256,
    repository: 'https://example.com/fixture', sourceSha: 'a'.repeat(40), entryIds: [] }
  await mkdir(embedding, { mode: 0o700 })
  await writeFile(join(embedding, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [row] }), { mode: 0o600 })
  await writeFile(join(embedding, row.file), archive, { mode: 0o600 })
  const spec = `file:.bundled-plugins/${sha256}.tgz`
  await mkdir(join(web, '.bundled-plugins'), { mode: 0o700 })
  const source = join(web, '.bundled-plugins', `${sha256}.tgz`)
  await writeFile(source, archive, { mode: 0o600 })
  await writeFile(join(web, 'package.json'), JSON.stringify({ dependencies: { [name]: spec } }), { mode: 0o600 })
  const lock = { importers: { '.': { dependencies: { [name]: { specifier: spec, version: spec } } } },
    packages: { [`${name}@${spec}`]: { version: row.version,
      resolution: { tarball: spec, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` } } } }
  await writeFile(join(web, 'pnpm-lock.yaml'), JSON.stringify(lock), { mode: 0o600 })
  return { catalog: BundledPluginCatalog.load(embedding, process.getuid?.() ?? 0), row, archive, spec, lock, source, installed, embedding }
}
