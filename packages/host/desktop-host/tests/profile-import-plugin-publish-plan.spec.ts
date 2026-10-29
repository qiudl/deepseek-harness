import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { fingerprintProfileImportPluginWeb } from '../src/profile-import-plugin-publish-plan.ts'

const uid = process.getuid?.() ?? 0

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-publish-plan-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules'), { mode: 0o700 })
  const manifest = join(root, 'package.json')
  await writeFile(manifest, '{"dependencies":{}}\n', { mode: 0o600 })
  return { root, manifest, modules: join(root, 'node_modules') }
}

it.skipIf(process.platform === 'win32')('fingerprints plugin bytes and modes and rejects an unknown live file', async () => {
  const { root, manifest } = await fixture()
  const original = await fingerprintProfileImportPluginWeb(root, uid)
  await writeFile(manifest, '{"dependencies":{"changed":"1"}}\n')
  expect(await fingerprintProfileImportPluginWeb(root, uid)).not.toBe(original)
  await writeFile(manifest, '{"dependencies":{}}\n')
  await chmod(manifest, 0o400)
  expect(await fingerprintProfileImportPluginWeb(root, uid)).not.toBe(original)
  await chmod(manifest, 0o600)
  expect(await fingerprintProfileImportPluginWeb(root, uid)).toBe(original)
  await writeFile(join(root, 'unexpected.txt'), 'unmanaged')
  await expect(fingerprintProfileImportPluginWeb(root, uid))
    .rejects.toThrow('profile_import_plugin_publish_layout_unsupported')
})

it.skipIf(process.platform === 'win32')('rejects linked, writable, and oversized plugin content', async () => {
  const { root, modules, manifest } = await fixture()
  const linked = join(modules, 'linked.js')
  await symlink(manifest, linked)
  await expect(fingerprintProfileImportPluginWeb(root, uid))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
  await unlink(linked)
  await chmod(modules, 0o777)
  await expect(fingerprintProfileImportPluginWeb(root, uid))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
  await chmod(modules, 0o700)
  const oversized = join(modules, 'oversized.bin')
  await writeFile(oversized, '')
  await truncate(oversized, 256 * 1024 * 1024 + 1)
  await expect(fingerprintProfileImportPluginWeb(root, uid))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
})

it.skipIf(process.platform === 'win32')('rejects a hard link to a file outside the plugin tree', async () => {
  const { root, modules } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-import-publish-private-'))
  onTestFinished(() => rm(outside, { recursive: true, force: true }))
  const privateFile = join(outside, 'private.txt')
  await writeFile(privateFile, 'keep outside the imported plugin', { mode: 0o600 })
  await link(privateFile, join(modules, 'linked.txt'))
  await expect(fingerprintProfileImportPluginWeb(root, uid))
    .rejects.toThrow('profile_import_plugin_publish_unsafe')
  expect(await readFile(privateFile, 'utf8')).toBe('keep outside the imported plugin')
})
