import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { createLegacyMigrationExportService } from '../src/legacy-migration-source.ts'

const uid = process.getuid?.() ?? 0

async function fixture(): Promise<{ home: string; source: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-legacy-source-'))
  const source = join(home, '.dsh')
  const session = join(source, 'sessions', '_no-cwd', 'session-1')
  await mkdir(session, { recursive: true, mode: 0o700 })
  await mkdir(join(source, 'sessions', '_no-cwd', 'preset-user-default'), { mode: 0o700 })
  await mkdir(join(source, 'storages'), { mode: 0o700 })
  await mkdir(join(source, 'profiles', 'web'), { recursive: true, mode: 0o700 })
  await mkdir(join(source, 'profiles', 'node_modules'), { mode: 0o755 })
  await mkdir(join(source, 'host'), { mode: 0o700 })
  await writeFile(join(session, 'session.jsonl.zstd'), Buffer.concat(await Promise.all([
    compressZstdFrame(`${JSON.stringify({
      type: 'session', version: 0, id: 'session-1', createdAt: 1, delegationDepth: 0,
    })}\n`),
    compressZstdFrame(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`),
  ])), { mode: 0o600 })
  await writeFile(join(source, 'settings.yaml'), JSON.stringify({
    permission: { defaultPreset: 'workspace-write' },
  }), { mode: 0o600 })
  await writeFile(join(source, '.credentials.yaml'), JSON.stringify({
    version: 1, refs: { DEEPSEEK_API_KEY: 'secret' }, records: {},
  }), { mode: 0o600 })
  await writeFile(join(source, '.anonymous-user-id'), '11111111-1111-4111-8111-111111111111\n', { mode: 0o644 })
  await writeFile(join(source, 'package.json'), '{"private":true}\n', { mode: 0o644 })
  await writeFile(join(source, 'cordis.yml'), '[]\n', { mode: 0o644 })
  await writeFile(join(source, 'pnpm-workspace.yaml'), 'packages:\n  - profiles/*\n', { mode: 0o644 })
  await writeFile(join(source, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['workspace-1'], archivedSessionIds: [] },
    tables: { workspaces: { 'workspace-1': {
      path: '/workspace', title: 'Fixture', sessionIds: ['session-1'],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    } } },
  }), { mode: 0o600 })
  await writeFile(join(source, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: {} },
  }), { mode: 0o600 })
  await writeFile(join(source, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }), { mode: 0o644 })
  await writeFile(join(source, 'profiles', 'web', 'cordis.yml'), '[]\n', { mode: 0o644 })
  await writeFile(join(source, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', { mode: 0o644 })
  await writeFile(join(source, 'profiles', 'web', 'pnpm-workspace.yaml'), [
    'packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', '',
  ].join('\n'), { mode: 0o644 })
  await chmod(source, 0o700)
  return { home, source }
}

describe('fixed owner legacy migration source', () => {
  it('exports ordinary JSONL and four owner documents without writing the source', async () => {
    const { home, source } = await fixture()
    const before = createHash('sha256').update(await readFile(join(source, '.credentials.yaml'))).digest('hex')
    let transferred = ''
    const service = createLegacyMigrationExportService({
      expectedUid: uid,
      _testOwnerHome: home,
      assertSourceQuiescent: async () => undefined,
      stageOwnerTransfer: async (bundle) => {
        transferred = JSON.stringify(bundle)
        return { transferId: 'a'.repeat(48), transferDigest: 'b'.repeat(64) }
      },
    })
    const proof = await service.inventory()
    const receipt = await service.begin({
      expectedInventoryDigest: proof.inventoryDigest,
      maxRecords: proof.requiredMaxRecords,
      maxBytes: proof.requiredMaxBytes,
    })
    expect(receipt.recordCount).toBe(6)
    expect(transferred).toContain('secret')
    expect(JSON.stringify(service.read({ exportId: receipt.exportId, chunkIndex: 0 }))).not.toContain('secret')
    expect(createHash('sha256').update(await readFile(join(source, '.credentials.yaml'))).digest('hex')).toBe(before)
  })

  it('fails closed before transfer when the source is running or contains an unknown entry', async () => {
    const { home, source } = await fixture()
    const running = createLegacyMigrationExportService({
      expectedUid: uid, _testOwnerHome: home,
      assertSourceQuiescent: async () => { throw new Error('legacy_source_running') },
      stageOwnerTransfer: async () => { throw new Error('unexpected_transfer') },
    })
    await expect(running.inventory()).rejects.toThrow(/running/u)
    await writeFile(join(source, 'custom-plugin.yaml'), 'enabled: true\n', { mode: 0o600 })
    const unknown = createLegacyMigrationExportService({
      expectedUid: uid, _testOwnerHome: home,
      assertSourceQuiescent: async () => undefined,
      stageOwnerTransfer: async () => { throw new Error('unexpected_transfer') },
    })
    await expect(unknown.inventory()).rejects.toThrow(/unknown_entry/u)
  })

  it('recomputes the owner inventory at begin and rejects a post-confirmation change', async () => {
    const { home, source } = await fixture()
    let transferred = false
    const service = createLegacyMigrationExportService({
      expectedUid: uid, _testOwnerHome: home,
      assertSourceQuiescent: async () => undefined,
      stageOwnerTransfer: async () => { transferred = true; throw new Error('unexpected_transfer') },
    })
    const proof = await service.inventory()
    await writeFile(join(source, '.credentials.yaml'), JSON.stringify({
      version: 1, refs: { DEEPSEEK_API_KEY: 'changed' }, records: {},
    }), { mode: 0o600 })
    await expect(service.begin({
      expectedInventoryDigest: proof.inventoryDigest,
      maxRecords: proof.requiredMaxRecords,
      maxBytes: proof.requiredMaxBytes,
    })).rejects.toThrow(/inventory_changed/u)
    expect(transferred).toBe(false)
  })

  it('rejects a torn final Zstandard frame instead of exporting its prefix', async () => {
    const { home, source } = await fixture()
    const log = join(source, 'sessions', '_no-cwd', 'session-1', 'session.jsonl.zstd')
    const bytes = await readFile(log)
    await writeFile(log, bytes.subarray(0, bytes.length - 2), { mode: 0o600 })
    const service = createLegacyMigrationExportService({
      expectedUid: uid, _testOwnerHome: home,
      assertSourceQuiescent: async () => undefined,
      stageOwnerTransfer: async () => { throw new Error('unexpected_transfer') },
    })
    await expect(service.inventory()).rejects.toThrow(/corrupt/u)
  })
})
