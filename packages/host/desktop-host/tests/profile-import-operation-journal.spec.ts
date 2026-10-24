import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { FileProfileImportOperationJournal } from '../src/profile-import-operation-journal.ts'

const uid = process.getuid?.() ?? 0
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-operation-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'control', 'profile-import-operations')
  await mkdir(join(root, 'control'), { mode: 0o700 })
  const journal = new FileProfileImportOperationJournal(directory, uid)
  const sourceSnapshotDigest = 'a'.repeat(64), targetSnapshotDigest = 'b'.repeat(64)
  const input = {
    operationId: randomUUID(), sourceProfileId: randomUUID(), targetProfileId: randomUUID(),
    sourceSnapshotDigest, targetSnapshotDigest,
    previewDigest: digest([sourceSnapshotDigest, targetSnapshotDigest]),
    selectedSessionIds: ['session-one'], selectedPluginNames: ['dsh-duet'],
    targetGeneration: 2, stagedGeneration: 3,
  }
  return { root, directory, journal, input }
}

describe.skipIf(process.platform === 'win32')('Profile import operation journal', () => {
  it('rejects invalid authority and a record moved under another operation ID', async () => {
    const { directory, journal, input } = await fixture()
    expect(() => new FileProfileImportOperationJournal('relative', uid))
      .toThrow('profile_import_journal_invalid')
    expect(() => new FileProfileImportOperationJournal(directory, -1))
      .toThrow('profile_import_journal_invalid')
    await expect(journal.load('invalid')).rejects.toThrow('profile_import_journal_invalid')
    await expect(journal.listForPair('invalid', input.targetProfileId))
      .rejects.toThrow('profile_import_journal_invalid')
    const prepared = await journal.create(input)
    expect(await journal.load(randomUUID())).toBeNull()
    await writeFile(join(directory, `${input.operationId}.1.json`),
      `${JSON.stringify({ ...prepared, operationId: randomUUID() })}\n`, { mode: 0o600 })
    await expect(journal.load(input.operationId)).rejects.toThrow('profile_import_journal_invalid')
    await writeFile(join(directory, `${input.operationId}.1.json`),
      `${JSON.stringify({ ...prepared, revision: 2 })}\n`, { mode: 0o600 })
    await expect(journal.load(input.operationId)).rejects.toThrow('profile_import_journal_invalid')
  })

  it('rejects an oversized intent before leaving an operation record', async () => {
    const { directory, journal, input } = await fixture()
    const selectedSessionIds = Array.from({ length: 10_000 }, (_, index) =>
      `session-${String(index).padStart(5, '0')}-${'x'.repeat(230)}`)
    await expect(journal.create({ ...input, selectedSessionIds }))
      .rejects.toThrow('profile_import_journal_too_large')
    expect(await journal.load(input.operationId)).toBeNull()
    expect(await readdir(directory)).toEqual([])
  })

  it('refuses a journal directory opened to other users', async () => {
    const { directory, journal, input } = await fixture()
    await journal.create(input)
    await chmod(directory, 0o755)
    await expect(journal.load(input.operationId)).rejects.toThrow('profile_import_journal_unsafe')
    await expect(journal.create({ ...input, operationId: randomUUID() }))
      .rejects.toThrow('profile_import_journal_unsafe')
  })

  it('records intent before mutation and advances through strict durable versions', async () => {
    const { directory, journal, input } = await fixture()
    expect(await journal.load(input.operationId)).toBeNull()
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    const prepared = await journal.create(input)
    expect(prepared.phase).toBe('prepared')
    expect(await journal.load(input.operationId)).toEqual(prepared)
    await expect(journal.create(input)).rejects.toThrow('profile_import_journal_stale')
    const fenced = await journal.advance(prepared, 'fenced')
    const staged = await journal.advance(fenced, 'staged')
    await expect(journal.advance(prepared, 'aborted')).rejects.toThrow('profile_import_journal_stale')
    const committing = await journal.advance(staged, 'committing')
    expect((await new FileProfileImportOperationJournal(directory, uid).load(input.operationId))?.phase)
      .toBe('committing')
    await expect(journal.advance(committing, 'aborted')).rejects.toThrow('profile_import_journal_state')
    const committed = await journal.advance(committing, 'committed')
    expect(committed.revision).toBe(5)
    expect(await readdir(directory)).toEqual([1, 2, 3, 4, 5].map(version => `${input.operationId}.${version}.json`))
    expect(JSON.stringify(committed)).not.toContain('credential')
    expect(await new FileProfileImportOperationJournal(directory, uid)
      .listForPair(input.sourceProfileId, input.targetProfileId)).toEqual([committed])
    expect(await journal.listForPair(input.targetProfileId, input.sourceProfileId)).toEqual([])
  })

  it('rediscovers only operations belonging to the authorized Profile pair', async () => {
    const { journal, input } = await fixture()
    expect(await journal.listForPair(input.sourceProfileId, input.targetProfileId)).toEqual([])
    const first = await journal.create(input)
    const second = await journal.create({ ...input, operationId: randomUUID() })
    await journal.create({ ...input, operationId: randomUUID(), targetProfileId: randomUUID() })
    expect(await journal.listForPair(input.sourceProfileId, input.targetProfileId))
      .toEqual([first, second].sort((left, right) => left.operationId.localeCompare(right.operationId)))
    await expect(journal.listForPair(input.sourceProfileId, input.sourceProfileId))
      .rejects.toThrow('profile_import_journal_invalid')
  })

  it('rejects changed selection, invalid snapshots, and unsupported transitions', async () => {
    const { journal, input } = await fixture()
    await expect(journal.create({ ...input, previewDigest: '0'.repeat(64) }))
      .rejects.toThrow('profile_import_journal_invalid')
    await expect(journal.create({ ...input, selectedSessionIds: ['one', 'one'] }))
      .rejects.toThrow('profile_import_journal_invalid')
    const prepared = await journal.create(input)
    await expect(journal.advance(prepared, 'committed')).rejects.toThrow('profile_import_journal_state')
    await expect(journal.advance({ ...prepared, selectedSessionIds: ['other'] }, 'fenced'))
      .rejects.toThrow('profile_import_journal_stale')
  })

  it('permits a dedicated plugin abort from committing while preserving the session-only rule', async () => {
    const { journal, input } = await fixture()
    const pluginPrepared = await journal.create(input)
    const pluginFenced = await journal.advance(pluginPrepared, 'fenced')
    const pluginStaged = await journal.advance(pluginFenced, 'staged')
    const pluginCommitting = await journal.advance(pluginStaged, 'committing')
    expect((await journal.abortPluginCommitting(pluginCommitting)).phase).toBe('aborted')
    await expect(journal.abortPluginCommitting(pluginCommitting)).rejects.toThrow('profile_import_journal_stale')
    const other = await fixture()
    const sessionPrepared = await other.journal.create({ ...other.input, selectedPluginNames: [] })
    const sessionFenced = await other.journal.advance(sessionPrepared, 'fenced')
    const sessionStaged = await other.journal.advance(sessionFenced, 'staged')
    const sessionCommitting = await other.journal.advance(sessionStaged, 'committing')
    await expect(other.journal.abortPluginCommitting(sessionCommitting))
      .rejects.toThrow('profile_import_journal_state')
  })

  it('fails closed for a corrupt highest version and an unsafe journal file', async () => {
    const { directory, journal, input } = await fixture()
    const prepared = await journal.create(input)
    const fenced = await journal.advance(prepared, 'fenced')
    const latest = join(directory, `${input.operationId}.${fenced.revision}.json`)
    await writeFile(latest, '{corrupt', { mode: 0o600 })
    await expect(journal.load(input.operationId)).rejects.toThrow('profile_import_journal_invalid')
    await rm(latest)
    const replacement = join(directory, 'replacement.json')
    await writeFile(replacement, `${JSON.stringify(fenced)}\n`, { mode: 0o600 })
    await symlink(replacement, latest)
    await expect(journal.load(input.operationId)).rejects.toThrow()
    expect(JSON.parse(await readFile(join(directory, `${input.operationId}.1.json`), 'utf8')))
      .toEqual(prepared)
  })

  it('rejects a malformed newer version and a redirected parent directory', async () => {
    const { root, directory, journal, input } = await fixture()
    await journal.create(input)
    const malformed = join(directory, `${input.operationId}.99999999999999999999.json`)
    await writeFile(malformed, '{}', { mode: 0o600 })
    await expect(journal.load(input.operationId)).rejects.toThrow('profile_import_journal_invalid')
    await rm(malformed)
    const alias = join(root, 'alias')
    await symlink(join(root, 'control'), alias)
    const redirected = new FileProfileImportOperationJournal(join(alias, 'profile-import-operations'), uid)
    await expect(redirected.load(input.operationId)).rejects.toThrow('profile_import_journal_unsafe')
  })
})
