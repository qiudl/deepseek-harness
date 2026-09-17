import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import {
  migrationOwnerStateRecords,
  type MigrationOwnerStateBundle,
  type MigrationOwnerTransferBundle,
} from '../src/migration-export.ts'

const fsFaults = vi.hoisted(() => ({
  escapedRealpath: '' as string,
  failingLinkTarget: '' as string,
  failingMkdirPath: '' as string,
}))

const formatFaults = vi.hoisted(() => ({ escapeLog: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: async (existingPath: string, newPath: string) => {
      if (newPath === fsFaults.failingLinkTarget) throw { code: 'EPERM' }
      return actual.link(existingPath, newPath)
    },
    mkdir: async (path: string, options?: { mode?: number; recursive?: boolean }) => {
      if (path === fsFaults.failingMkdirPath) throw Object.assign(new Error('injected mkdir failure'), { code: 'EACCES' })
      return actual.mkdir(path, options)
    },
    realpath: async (path: string) => {
      if (path === fsFaults.escapedRealpath) return join(tmpdir(), 'dsh-migration-escaped')
      return actual.realpath(path)
    },
  }
})

vi.mock('../src/format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/format.js')>()
  return {
    ...actual,
    logPath: (root: string, cwd: string | undefined, id: SessionId, compression: 'none' | 'zstd') => formatFaults.escapeLog
      ? join(root, '..', 'escaped', actual.generationLogFilename(SESSION_FORMAT_VERSION, compression))
      : actual.logPath(root, cwd, id, compression),
  }
})

const {
  FileOwnerJsonlMigrationGenerationTarget,
  FileOwnerMigrationImportJournal,
  FileOwnerMigrationTransferStore,
} = await import('../src/migration-import.ts')

const uid = process.getuid?.() ?? 0
const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('session-fault'),
  createdAt: 1,
  isSeeded: false,
}
const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}

function transferBundle(): MigrationOwnerTransferBundle {
  const records = migrationOwnerStateRecords(ownerState)
  return {
    version: 1,
    schemaVersion: 0,
    sourceInventoryDigest: '1'.repeat(64),
    sourceGeneration: '2'.repeat(64),
    recordCount: records.length,
    semanticDigest: migrationSemanticDigest(records),
    ownerState,
    sessions: [],
  }
}

function journalStage() {
  return {
    importId: '1'.repeat(48),
    version: 1,
    state: 'preparing' as const,
    transferId: '2'.repeat(48),
    transferDigest: '3'.repeat(64),
    sourceInstallationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150',
    sourceInventoryDigest: '4'.repeat(64),
    sourceGeneration: '5'.repeat(64),
    sourceSchemaVersion: 0,
    targetProfileSelectorHash: '6'.repeat(64),
    targetGeneration: 5,
    recordCount: 0,
    semanticDigest: '7'.repeat(64),
  }
}

afterEach(() => {
  fsFaults.escapedRealpath = ''
  fsFaults.failingLinkTarget = ''
  fsFaults.failingMkdirPath = ''
  formatFaults.escapeLog = false
})

describe('migration import filesystem fault boundaries', () => {
  it('rejects a transfer whose canonical file escapes its private root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-transfer-realpath-fault-'))
    const store = new FileOwnerMigrationTransferStore(root, uid)
    const transfer = await store.stage(transferBundle())
    fsFaults.escapedRealpath = join(root, `${transfer.transferId}.json`)
    await expect(store.resolve(transfer.transferId, transfer.transferDigest)).rejects.toThrow(/transfer_unsafe/u)
  })

  it('propagates initial active-record publication failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-generation-link-fault-'))
    await mkdir(join(root, 'generations'), { mode: 0o700 })
    await mkdir(join(root, 'active'), { mode: 0o700 })
    fsFaults.failingLinkTarget = join(root, 'active', 'active.1.json')
    await expect(new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4).activeGeneration())
      .rejects.toMatchObject({ code: 'EPERM' })
  })

  it.each(['generations', 'active'])('propagates failure while creating the %s root', async (name) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-generation-${name}-fault-`))
    if (name === 'active') await mkdir(join(root, 'generations'), { mode: 0o700 })
    fsFaults.failingMkdirPath = join(root, name)
    await expect(new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4).activeGeneration())
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects canonical generation and session paths that escape their owner roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-generation-realpath-fault-'))
    const target = new FileOwnerJsonlMigrationGenerationTarget(root, uid, 4)
    await target.prepareEmptyGeneration(5)
    fsFaults.escapedRealpath = target.generationRoot(5)
    await expect(target.importOwnerState(5, ownerState)).rejects.toThrow(/generation_unsafe/u)
    fsFaults.escapedRealpath = ''
    formatFaults.escapeLog = true
    await expect(target.importSession(5, header, [])).rejects.toThrow(/generation_unsafe/u)
  })

  it('propagates journal publication failures and removes the temporary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-link-fault-'))
    const stage = journalStage()
    fsFaults.failingLinkTarget = join(root, `${stage.importId}.1.json`)
    await expect(new FileOwnerMigrationImportJournal(root, uid).create(stage))
      .rejects.toMatchObject({ code: 'EPERM' })
    expect(await import('node:fs/promises').then(fs => fs.readdir(root))).toEqual([])
  })
})
