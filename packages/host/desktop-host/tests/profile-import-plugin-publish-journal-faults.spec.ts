import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  rootStat: '' as '' | 'EACCES' | 'ENOENT',
  mkdir: false, link: false, unlink: false,
  directoryState: '' as string,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const failure = (code: string) => Object.assign(Error(`injected ${code}`), { code })
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]).endsWith('/plugin-publish') && faults.rootStat) {
        throw failure(faults.rootStat)
      }
      return actual.lstat(...args)
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]).endsWith('/plugin-publish') && faults.mkdir) throw failure('EACCES')
      return actual.mkdir(...args)
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (faults.link) throw failure('EACCES')
      return actual.link(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (faults.unlink && String(args[0]).endsWith('.tmp')) throw failure('EACCES')
      return actual.unlink(...args)
    },
  }
})

vi.mock('../src/profile-import-plugin-publish-plan.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/profile-import-plugin-publish-plan.ts')>()
  return { ...actual, inspectProfileImportPluginDirectoryState: async (...args:
  Parameters<typeof actual.inspectProfileImportPluginDirectoryState>) => faults.directoryState
      || actual.inspectProfileImportPluginDirectoryState(...args) }
})

const { FileProfileImportPluginPublishJournal, inspectProfileImportPluginPublishRecovery } =
  await import('../src/profile-import-plugin-publish-journal.ts')

const uid = process.getuid?.() ?? 0
const plan = { targetWebDigest: 'a'.repeat(64), candidateWebDigest: 'b'.repeat(64),
  beforeEntryDigest: 'c'.repeat(64), afterEntryDigest: 'd'.repeat(64) }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-publish-fault-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const journal = new FileProfileImportPluginPublishJournal(join(root, 'plugin-publish'), uid)
  const input = { operationId: randomUUID(), sourceProfileId: randomUUID(),
    targetProfileId: randomUUID(), selectedPluginNames: ['fixture-plugin'], plan }
  return { root, journal, input }
}

afterEach(() => {
  faults.rootStat = ''
  faults.mkdir = false
  faults.link = false
  faults.unlink = false
  faults.directoryState = ''
  vi.restoreAllMocks()
})

it.skipIf(process.platform === 'win32')('fails closed on inaccessible or vanished journal storage', async () => {
  const { journal, input } = await fixture()
  faults.rootStat = 'EACCES'
  await expect(journal.load(input.operationId)).rejects.toMatchObject({ code: 'EACCES' })
  faults.rootStat = ''
  faults.mkdir = true
  await expect(journal.create(input)).rejects.toMatchObject({ code: 'EACCES' })
  faults.mkdir = false
  faults.rootStat = 'ENOENT'
  await expect(journal.create(input)).rejects.toThrow('profile_import_plugin_publish_journal_unsafe')
})

it.skipIf(process.platform === 'win32')('rejects oversized records and interrupted immutable writes', async () => {
  const { journal, input } = await fixture()
  vi.spyOn(Buffer, 'from').mockReturnValueOnce(Buffer.alloc(256 * 1024 + 1))
  await expect(journal.create(input)).rejects.toThrow('profile_import_plugin_publish_journal_invalid')
  vi.restoreAllMocks()
  faults.link = true
  await expect(journal.create(input)).rejects.toMatchObject({ code: 'EACCES' })
  faults.link = false
  faults.unlink = true
  await expect(journal.create(input)).rejects.toMatchObject({ code: 'EACCES' })
})

it.skipIf(process.platform === 'win32')('requires matching intent and a recognized recovery state', async () => {
  const { root, journal, input } = await fixture()
  const recovery = { journal, profileRoot: root, operationId: input.operationId,
    sourceProfileId: input.sourceProfileId, targetProfileId: input.targetProfileId, uid }
  await expect(inspectProfileImportPluginPublishRecovery(recovery))
    .rejects.toThrow('profile_import_plugin_publish_journal_invalid')
  await journal.create(input)
  await expect(inspectProfileImportPluginPublishRecovery({ ...recovery, sourceProfileId: randomUUID() }))
    .rejects.toThrow('profile_import_plugin_publish_journal_invalid')
  faults.directoryState = 'unrecognized'
  await expect(inspectProfileImportPluginPublishRecovery(recovery))
    .rejects.toThrow('profile_import_plugin_publish_recovery_unknown')
})
