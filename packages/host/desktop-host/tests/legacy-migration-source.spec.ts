import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { compressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { createLegacyMigrationExportService } from '../src/legacy-migration-source.ts'

const uid = process.getuid?.() ?? 0

async function fixture(): Promise<{ home: string; source: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-legacy-source-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
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
    name: 'dsh-profile-web', private: true,
    dependencies: { '@deepseek-ai/dsh-base': '1.0.0', '@deepseek-ai/dsh-web-app': '1.0.0' },
    dsh: { profile: { patchReload: 'live', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }), { mode: 0o644 })
  await writeFile(join(source, 'profiles', 'web', 'cordis.yml'), '[]\n', { mode: 0o644 })
  await writeFile(join(source, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', { mode: 0o644 })
  await writeFile(join(source, 'profiles', 'web', 'pnpm-workspace.yaml'), [
    'packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', '',
  ].join('\n'), { mode: 0o644 })
  await chmod(source, 0o700)
  return { home, source }
}

function service(home: string) {
  return createLegacyMigrationExportService({
    expectedUid: uid,
    _testOwnerHome: home,
    assertSourceQuiescent: async () => undefined,
    stageOwnerTransfer: async () => { throw new Error('unexpected_transfer') },
  })
}

describe('fixed owner legacy migration source', () => {
  it('keeps legacy model credentials and routes inactive without rewriting the source', async () => {
    const { home, source } = await fixture()
    const path = join(source, '.credentials.yaml')
    await writeFile(path, JSON.stringify({
      DEEPSEEK_API_KEY: 'legacy-secret', CUSTOM_API_KEY: 'custom-secret',
    }), { mode: 0o600 })
    const settingsPath = join(source, 'settings.yaml')
    await writeFile(settingsPath, JSON.stringify({
      permission: { defaultPreset: 'workspace-write' },
      'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      'llm-pi-ai': { providers: { custom: { apiKeyEnv: 'CUSTOM_API_KEY' } } },
      'subagent-model-selection': { enabled: true, allowedModels: [{ provider: 'custom', model: 'm' }] },
    }), { mode: 0o600 })
    const before = createHash('sha256').update(await readFile(path)).digest('hex')
    const settingsBefore = createHash('sha256').update(await readFile(settingsPath)).digest('hex')
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
    await service.begin({
      expectedInventoryDigest: proof.inventoryDigest,
      maxRecords: proof.requiredMaxRecords,
      maxBytes: proof.requiredMaxBytes,
    })

    expect(transferred).not.toContain('legacy-secret')
    expect(transferred).not.toContain('custom-secret')
    expect(transferred).not.toContain('CUSTOM_API_KEY')
    expect(transferred).not.toContain('llm-deepseek')
    expect(transferred).not.toContain('llm-pi-ai')
    expect(transferred).not.toContain('subagent-model-selection')
    expect(transferred).toContain('workspace-write')
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before)
    expect(createHash('sha256').update(await readFile(settingsPath)).digest('hex')).toBe(settingsBefore)
  })

  it('rejects mixed flat and versioned credential schemas', async () => {
    const { home, source } = await fixture()
    await writeFile(join(source, '.credentials.yaml'), JSON.stringify({
      version: 1, refs: {}, records: {}, DEEPSEEK_API_KEY: 'legacy-secret',
    }), { mode: 0o600 })
    const service = createLegacyMigrationExportService({
      expectedUid: uid,
      _testOwnerHome: home,
      assertSourceQuiescent: async () => undefined,
      stageOwnerTransfer: async () => { throw new Error('unexpected_transfer') },
    })

    await expect(service.inventory()).rejects.toThrow(/schema_unsupported/u)
  })

  it('accepts both released credential record kinds and nested JSON grant payloads', async () => {
    const { home, source } = await fixture()
    await writeFile(join(source, '.credentials.yaml'), JSON.stringify({
      version: 1,
      refs: { DEEPSEEK_API_KEY: 'secret' },
      records: {
        'deepseek/api': { kind: 'api-key', key: 'secret', env: { DEEPSEEK_API_KEY: 'secret' } },
        'deepseek/grant': { kind: 'grant', payload: { scopes: ['chat', 1, true, null] } },
      },
    }), { mode: 0o600 })

    await expect(service(home).inventory()).resolves.toMatchObject({ requiredMaxRecords: 6 })
  })

  it('accepts empty and minimal versioned credential documents', async () => {
    const variants = ['{}\n', 'version: 1\n', 'version: 1\nrecords:\n  deepseek/api:\n    kind: api-key\n']
    for (const value of variants) {
      const { home, source } = await fixture()
      await writeFile(join(source, '.credentials.yaml'), value, { mode: 0o600 })
      await expect(service(home).inventory()).resolves.toMatchObject({ requiredMaxRecords: 6 })
    }
  })

  it('rejects malformed legacy credential variants', async () => {
    const variants: unknown[] = [
      [],
      { 'INVALID-REF': 'secret' },
      { version: 2, refs: {}, records: {} },
      { version: 1, refs: { 'INVALID-REF': 'secret' }, records: {} },
      { version: 1, refs: {}, records: { invalid: { kind: 'api-key', key: 'secret' } } },
      { version: 1, refs: {}, records: { 'deepseek/api': 'secret' } },
      { version: 1, refs: {}, records: { 'deepseek/api': { kind: 'api-key', extra: true } } },
      { version: 1, refs: {}, records: { 'deepseek/api': { kind: 'api-key', key: '' } } },
      { version: 1, refs: {}, records: { 'deepseek/api': { kind: 'api-key', env: [] } } },
      { version: 1, refs: {}, records: { 'deepseek/api': { kind: 'api-key', env: { TOKEN: '' } } } },
      { version: 1, refs: {}, records: { 'deepseek/grant': { kind: 'grant' } } },
      { version: 1, refs: {}, records: { 'deepseek/grant': { kind: 'grant', payload: 1, extra: true } } },
      { version: 1, refs: {}, records: { 'deepseek/unknown': { kind: 'password' } } },
    ]

    for (const value of variants) {
      const { home, source } = await fixture()
      await writeFile(join(source, '.credentials.yaml'), JSON.stringify(value), { mode: 0o600 })
      await expect(service(home).inventory()).rejects.toThrow(/schema_unsupported/u)
    }
  })

  it('rejects unsafe owner paths and malformed owner documents', async () => {
    {
      const { home, source } = await fixture()
      await chmod(source, 0o777)
      await expect(service(home).inventory()).rejects.toThrow(/source_unsafe/u)
    }
    {
      const { home, source } = await fixture()
      await chmod(join(source, 'settings.yaml'), 0o644)
      await expect(service(home).inventory()).rejects.toThrow(/source_unsafe/u)
    }
    {
      const { home, source } = await fixture()
      await writeFile(join(source, 'settings.yaml'), 'duplicate: 1\nduplicate: 2\n', { mode: 0o600 })
      await expect(service(home).inventory()).rejects.toThrow(/schema_unsupported/u)
    }
    {
      const { home, source } = await fixture()
      await writeFile(join(source, 'settings.yaml'), '[]\n', { mode: 0o600 })
      await expect(service(home).inventory()).rejects.toThrow(/schema_unsupported/u)
    }
    {
      const { home, source } = await fixture()
      await writeFile(join(source, 'settings.yaml'), 'value: .nan\n', { mode: 0o600 })
      await expect(service(home).inventory()).rejects.toThrow(/schema_unsupported/u)
    }
    {
      const { home, source } = await fixture()
      await writeFile(join(source, '.anonymous-user-id'), 'not-a-uuid\n', { mode: 0o644 })
      await expect(service(home).inventory()).rejects.toThrow(/schema_unsupported/u)
    }
    {
      const { home, source } = await fixture()
      await writeFile(join(source, 'settings.yaml'), 'externalConnections: []\n', { mode: 0o600 })
      await expect(service(home).inventory()).rejects.toThrow(/schema_unsupported/u)
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked owner document', async () => {
    const { home, source } = await fixture()
    const manifest = join(source, 'profiles', 'web', 'package.json')
    await unlink(manifest)
    await symlink('cordis.yml', manifest)

    await expect(service(home).inventory()).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('allows absent optional owner documents', async () => {
    const { home, source } = await fixture()
    await Promise.all([
      unlink(join(source, '.anonymous-user-id')),
      unlink(join(source, 'package.json')),
      unlink(join(source, 'cordis.yml')),
      unlink(join(source, 'pnpm-workspace.yaml')),
    ])

    await expect(service(home).inventory()).resolves.toMatchObject({ requiredMaxRecords: 6 })
  })

  it('accepts released layouts with absent optional directories and empty defaults', async () => {
    const mutations: Array<(source: string) => Promise<unknown>> = [
      source => rm(join(source, 'profiles'), { recursive: true }),
      source => unlink(join(source, 'storages', 'session_projcache.json')),
      source => unlink(join(source, 'storages', 'workspace.json')),
      source => rm(join(source, 'storages'), { recursive: true }),
      source => writeFile(join(source, 'profiles', 'web', 'package.json'), JSON.stringify({
        dsh: { profile: { patchReload: 'live', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }), { mode: 0o644 }),
      source => writeFile(join(source, 'settings.yaml'), '', { mode: 0o600 }),
      source => writeFile(join(source, 'storages', 'workspace.json'), JSON.stringify({
        unit: { name: 'workspace', version: 2 }, tables: {},
      }), { mode: 0o600 }),
    ]

    for (const mutate of mutations) {
      const { home, source } = await fixture()
      await mutate(source)
      await expect(service(home).inventory()).resolves.toMatchObject({ requiredMaxRecords: 6 })
    }
  })

  it('uses the owner home and injected clock when production defaults are selected', async () => {
    const { home } = await fixture()
    vi.stubEnv('HOME', home)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const source = createLegacyMigrationExportService({
      expectedUid: uid,
      now: () => 123,
      assertSourceQuiescent: async () => undefined,
      stageOwnerTransfer: async () => { throw new Error('unexpected_transfer') },
    })
    await expect(source.inventory()).resolves.toMatchObject({ requiredMaxRecords: 6 })
  })

  it('rejects an owner document whose metadata changes during its bounded read', async () => {
    const { home, source } = await fixture()
    await writeFile(join(source, 'settings.yaml'), JSON.stringify({ padding: 'x'.repeat(15 * 1024 * 1024) }), { mode: 0o600 })
    let touching = true
    let tick = 0
    const changes = (async () => {
      while (touching) {
        const changed = new Date(1_700_000_000_000 + tick++ * 1_000)
        await utimes(join(source, 'settings.yaml'), changed, changed)
      }
    })()
    try {
      await expect(service(home).inventory()).rejects.toThrow(/source_changed/u)
    } finally {
      touching = false
      await changes
    }
  })

  it('rejects custom profile layouts and manifests', async () => {
    const mutations: Array<(source: string) => Promise<unknown>> = [
      source => mkdir(join(source, 'profiles', 'custom'), { mode: 0o700 }),
      source => writeFile(join(source, 'profiles', 'web', 'extra.yml'), '[]\n', { mode: 0o644 }),
      source => writeFile(join(source, 'profiles', 'web', 'package.json'), JSON.stringify({
        dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'restart' } },
      }), { mode: 0o644 }),
      source => writeFile(join(source, 'profiles', 'web', 'package.json'), JSON.stringify({
        dependencies: { custom: '1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }), { mode: 0o644 }),
      source => writeFile(join(source, 'profiles', 'web', 'package.json'), JSON.stringify({
        dependencies: { '@deepseek-ai/dsh-base': 1 },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }), { mode: 0o644 }),
      source => writeFile(join(source, 'profiles', 'web', 'cordis.patch.yml'), '- name: custom\n', { mode: 0o644 }),
      source => writeFile(join(source, 'profiles', 'web', 'cordis.yml'), '{}\n', { mode: 0o644 }),
      source => writeFile(join(source, 'profiles', 'web', 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n', { mode: 0o644 }),
    ]

    for (const mutate of mutations) {
      const { home, source } = await fixture()
      await mutate(source)
      await expect(service(home).inventory()).rejects.toThrow(/custom_profile/u)
    }
  })

  it('rejects unknown and malformed workspace storage', async () => {
    const mutations: Array<(source: string) => Promise<unknown>> = [
      source => writeFile(join(source, 'storages', 'custom.json'), '{}\n', { mode: 0o600 }),
      source => writeFile(join(source, 'storages', 'workspace.json'), JSON.stringify({
        unit: { name: 'workspace', version: 1 }, tables: { workspaces: {} },
      }), { mode: 0o600 }),
      source => writeFile(join(source, 'storages', 'workspace.json'), JSON.stringify({
        unit: { name: 'workspace', version: 2 }, tables: { workspaces: { unsafe: { path: 'relative' } } },
      }), { mode: 0o600 }),
    ]

    for (const mutate of mutations) {
      const { home, source } = await fixture()
      await mutate(source)
      await expect(service(home).inventory()).rejects.toThrow(/(?:unknown_entry|schema_unsupported)/u)
    }
  })

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
    expect(transferred).not.toContain('secret')
    expect(transferred).toContain('legacyModelSourceDigest')
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
