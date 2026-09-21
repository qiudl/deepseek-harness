import {
  chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { FileOwnerJsonlMigrationGenerationTarget } from '../src/migration-import.ts'
import {
  FileJsonlMigrationExportSource, SchemaAwareMigrationOwnerStateSource,
} from '../src/migration-export-source.ts'
import { migrationSourceInventoryDigest, type MigrationOwnerStateBundle } from '../src/migration-export.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const uid = process.getuid?.() ?? 0
const roots: string[] = []
const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}
const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('export-source'),
  createdAt: 1,
  isSeeded: false,
}
const events: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function fixture(): Promise<{
  root: string
  project: string
  session: string
  log: string
  target: FileOwnerJsonlMigrationGenerationTarget
  source: FileJsonlMigrationExportSource
}> {
  const base = await tempRoot('dsh-migration-export-source-')
  const target = new FileOwnerJsonlMigrationGenerationTarget(base, uid, 4)
  const active = await target.activePersistenceConfig()
  await target.importOwnerState(4, ownerState)
  await target.importSession(4, header, events)
  const project = join(active.root, '_no-cwd')
  const session = join(project, header.id)
  const log = join(session, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
  return {
    root: active.root,
    project,
    session,
    log,
    target,
    source: new FileJsonlMigrationExportSource(active.root, uid, { read: async () => ownerState }),
  }
}

async function manualLog(name: string, lines: readonly unknown[]): Promise<FileJsonlMigrationExportSource> {
  const root = await tempRoot('dsh-migration-export-manual-')
  const session = join(root, '_no-cwd', 'manual')
  await mkdir(session, { recursive: true, mode: 0o700 })
  await writeFile(join(session, name), lines.map(line => `${JSON.stringify(line)}\n`).join(''), { mode: 0o600 })
  return new FileJsonlMigrationExportSource(root, uid, { read: async () => ownerState })
}

describe('SchemaAwareMigrationOwnerStateSource', () => {
  it('reads the complete owner-owned schema set and validates it before publication', async () => {
    const readers = {
      settings: vi.fn(async () => ({ setting: true })),
      credentials: vi.fn<() => Promise<unknown>>(async () => ({ refs: {}, records: {} })),
      workspace: vi.fn(async () => ({ grants: ['/workspace'] })),
      profile: vi.fn(async () => ({ name: 'sdk', customPlugins: [] })),
    }
    const source = new SchemaAwareMigrationOwnerStateSource(readers)
    const state = await source.read()
    expect(state.version).toBe(1)
    expect(state.documents.map(document => document.kind)).toEqual([
      'settings', 'credentials', 'workspace', 'profile',
    ])
    expect(Object.values(readers).every(reader => reader.mock.calls.length === 1)).toBe(true)

    const controller = new AbortController()
    controller.abort()
    await expect(source.read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })

    readers.credentials.mockResolvedValueOnce({ refs: [] })
    await expect(source.read()).rejects.toThrow(/owner_state_invalid/u)
  })
})

describe('FileJsonlMigrationExportSource', () => {
  it('reads stable snapshots, cloned owner state, inspections, revisions, and inventory digests', async () => {
    const { source, target } = await fixture()
    await target.importSession(4, { ...header, id: SessionId('a-first') }, [])
    const snapshots = await source.listSnapshots()
    expect(snapshots.map(snapshot => snapshot.header.id)).toEqual(['a-first', 'export-source'])
    expect((await source.inspect(header.id)).events).toEqual(events)
    expect(await source.readStoredRevision(header.id)).toBe(snapshots[1]?.revision)
    expect(await source.readStoredRevision(SessionId('missing'))).toBeUndefined()
    await expect(source.inspect(SessionId('missing'))).rejects.toThrow(/not_found/u)
    expect(await source.inventoryDigest()).toBe(migrationSourceInventoryDigest(snapshots, ownerState))
    const cloned = await source.readOwnerState()
    expect(cloned).toEqual(ownerState)
    expect(cloned).not.toBe(ownerState)
  })

  it('rejects invalid owner identities and duplicate session ids', async () => {
    expect(() => new FileJsonlMigrationExportSource('/tmp', -1, { read: async () => ownerState }))
      .toThrow(/source_invalid/u)
    expect(() => new FileJsonlMigrationExportSource('/tmp', 0.5, { read: async () => ownerState }))
      .toThrow(/source_invalid/u)

    const { root, session, log, source } = await fixture()
    const duplicate = join(root, 'other', 'duplicate')
    await mkdir(duplicate, { recursive: true, mode: 0o700 })
    await copyFile(log, join(duplicate, `session.v${SESSION_FORMAT_VERSION}.jsonl`))
    await chmod(join(duplicate, `session.v${SESSION_FORMAT_VERSION}.jsonl`), 0o600)
    await expect(source.listSnapshots()).rejects.toThrow(/source_duplicate/u)
    await expect(source.inspect(header.id)).rejects.toThrow(/source_duplicate/u)
    await expect(source.readStoredRevision(header.id)).rejects.toThrow(/source_duplicate/u)
    expect(await readdir(session)).toContain(`session.v${SESSION_FORMAT_VERSION}.jsonl`)
  })

  it('accepts the reserved empty preset directory and rejects unsafe directory entries', async () => {
    const accepted = await fixture()
    await mkdir(join(accepted.project, 'preset-user-default'), { mode: 0o700 })
    await expect(accepted.source.listSnapshots()).resolves.toHaveLength(1)

    const topFile = await fixture()
    await writeFile(join(topFile.root, 'rogue'), 'unsafe', { mode: 0o600 })
    await expect(topFile.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const projectLink = await fixture()
    const outside = await tempRoot('dsh-migration-export-outside-')
    await symlink(outside, join(projectLink.root, 'linked'))
    await expect(projectLink.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const sessionFile = await fixture()
    await writeFile(join(sessionFile.project, 'rogue'), 'unsafe', { mode: 0o600 })
    await expect(sessionFile.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const empty = await fixture()
    await mkdir(join(empty.project, 'empty'), { mode: 0o700 })
    await expect(empty.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)
  })

  it('rejects mixed, missing, linked, permissive, and malformed generation files', async () => {
    const mixed = await fixture()
    await writeFile(join(mixed.session, 'session.jsonl.zstd'), 'unsafe', { mode: 0o600 })
    await expect(mixed.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const unexpected = await fixture()
    await writeFile(join(unexpected.session, 'unexpected'), 'unsafe', { mode: 0o600 })
    await expect(unexpected.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const linked = await fixture()
    await link(linked.log, join(linked.session, `session.v${SESSION_FORMAT_VERSION + 1}.jsonl`))
    await expect(linked.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const permissive = await fixture()
    await chmod(permissive.log, 0o644)
    await expect(permissive.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const empty = await fixture()
    await writeFile(empty.log, '')
    await expect(empty.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const corrupt = await fixture()
    await writeFile(corrupt.log, '{not-json}\n', { mode: 0o600 })
    await expect(corrupt.source.listSnapshots()).rejects.toThrow()

    const torn = await fixture()
    await writeFile(torn.log, `${await readFile(torn.log, 'utf8')}{"partial"`, { mode: 0o600 })
    await expect(torn.source.listSnapshots()).rejects.toThrow(/source_corrupt/u)

    const newline = await manualLog('session.jsonl', [])
    const newlineRoot = roots.at(-1)
    if (newlineRoot === undefined) throw new Error('missing test root')
    await writeFile(join(newlineRoot, '_no-cwd', 'manual', 'session.jsonl'), '\n', { mode: 0o600 })
    await expect(newline.listSnapshots()).rejects.toThrow(/corrupt/u)

    const permissiveRoot = await fixture()
    await chmod(permissiveRoot.root, 0o755)
    await expect(permissiveRoot.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)
  })

  it('validates the optional lease file independently of immutable generations', async () => {
    const valid = await fixture()
    await writeFile(join(valid.session, 'session.lock'), '', { mode: 0o644 })
    await expect(valid.source.listSnapshots()).resolves.toHaveLength(1)

    const content = await fixture()
    await writeFile(join(content.session, 'session.lock'), 'locked', { mode: 0o644 })
    await expect(content.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const writable = await fixture()
    await writeFile(join(writable.session, 'session.lock'), '', { mode: 0o666 })
    await chmod(join(writable.session, 'session.lock'), 0o666)
    await expect(writable.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)

    const linked = await fixture()
    const lease = join(linked.session, 'session.lock')
    await writeFile(lease, '', { mode: 0o644 })
    await link(lease, join(linked.session, 'lease-copy'))
    await unlink(join(linked.session, 'lease-copy'))
    const outside = join(await tempRoot('dsh-migration-export-lease-'), 'lease')
    await writeFile(outside, '', { mode: 0o644 })
    await unlink(lease)
    await link(outside, lease)
    await expect(linked.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)
  })

  it('upgrades released v0 logs with and without events', async () => {
    const legacyHeader = { type: 'session', version: 0, id: 'manual', createdAt: 1, delegationDepth: 0 }
    const event = { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }
    expect((await (await manualLog('session.jsonl', [legacyHeader])).inspect(SessionId('manual'))).events)
      .toEqual([])
    expect((await (await manualLog('session.jsonl', [legacyHeader, event])).inspect(SessionId('manual'))).events)
      .toHaveLength(1)
  })

  it('decodes complete legacy zstd frames and rejects corrupt compressed input', async () => {
    const legacyHeader = { type: 'session', version: 0, id: 'compressed', createdAt: 1, delegationDepth: 0 }
    const root = await tempRoot('dsh-migration-export-zstd-')
    const session = join(root, '_no-cwd', 'compressed')
    await mkdir(session, { recursive: true, mode: 0o700 })
    const bytes = Buffer.concat([
      await compressZstdFrame(`${JSON.stringify(legacyHeader)}\n`),
      await compressZstdFrame(`${JSON.stringify({ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } })}\n`),
    ])
    await writeFile(join(session, 'session.jsonl.zstd'), bytes, { mode: 0o600 })
    const source = new FileJsonlMigrationExportSource(root, uid, { read: async () => ownerState })
    await expect(source.inspect(SessionId('compressed'))).resolves.toMatchObject({ events: [{ type: 'turn/start' }] })

    await writeFile(join(session, 'session.jsonl.zstd'), Buffer.concat([bytes, Buffer.of(0)]), { mode: 0o600 })
    await expect(source.listSnapshots()).rejects.toThrow(/source_corrupt/u)

    const corrupt = await tempRoot('dsh-migration-export-zstd-corrupt-')
    const corruptSession = join(corrupt, '_no-cwd', 'corrupt')
    await mkdir(corruptSession, { recursive: true, mode: 0o700 })
    await writeFile(join(corruptSession, 'session.jsonl.zstd'), 'not-zstd', { mode: 0o600 })
    await expect(new FileJsonlMigrationExportSource(corrupt, uid, { read: async () => ownerState }).listSnapshots())
      .rejects.toThrow(/corrupt/u)
  })
})
