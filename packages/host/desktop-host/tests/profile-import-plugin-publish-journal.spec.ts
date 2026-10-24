import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { FileProfileImportPluginPublishJournal } from '../src/profile-import-plugin-publish-journal.ts'

const uid = process.getuid?.() ?? 0
const plan = { targetWebDigest: 'a'.repeat(64), candidateWebDigest: 'b'.repeat(64),
  beforeEntryDigest: 'c'.repeat(64), afterEntryDigest: 'd'.repeat(64) }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-publish-journal-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const journal = new FileProfileImportPluginPublishJournal(join(root, 'plugin-publish'), uid)
  const input = { operationId: randomUUID(), sourceProfileId: randomUUID(),
    targetProfileId: randomUUID(), selectedPluginNames: ['fixture-plugin'], plan }
  return { root, journal, input }
}

describe.skipIf(process.platform === 'win32')('plugin publish intent journal', () => {
  it('rejects invalid authority and a plan that cannot distinguish old and new web layers', async () => {
    const { root, journal, input } = await fixture()
    expect(() => new FileProfileImportPluginPublishJournal('relative', uid))
      .toThrow('profile_import_plugin_publish_journal_invalid')
    expect(() => new FileProfileImportPluginPublishJournal(join(root, 'plugin-publish'), -1))
      .toThrow('profile_import_plugin_publish_journal_invalid')
    await expect(journal.load('invalid')).rejects.toThrow('profile_import_plugin_publish_journal_invalid')
    await expect(journal.create({ ...input, selectedPluginNames: ['fixture-plugin', 'fixture-plugin'] }))
      .rejects.toThrow('profile_import_plugin_publish_journal_invalid')
    await expect(journal.create({ ...input, plan: { ...plan,
      candidateWebDigest: plan.targetWebDigest } }))
      .rejects.toThrow('profile_import_plugin_publish_journal_invalid')
    const prepared = await journal.create(input)
    expect(await journal.load(randomUUID())).toBeNull()
    const path = join(root, 'plugin-publish', `${input.operationId}.1.json`)
    await writeFile(path, `${JSON.stringify({ ...prepared, revision: 2 })}\n`, { mode: 0o600 })
    await expect(journal.load(input.operationId))
      .rejects.toThrow('profile_import_plugin_publish_journal_invalid')
  })

  it('refuses a publish journal directory exposed to other users', async () => {
    const { root, journal, input } = await fixture()
    await journal.create(input)
    const directory = join(root, 'plugin-publish')
    await chmod(directory, 0o755)
    await expect(journal.load(input.operationId))
      .rejects.toThrow('profile_import_plugin_publish_journal_unsafe')
    await expect(journal.create({ ...input, operationId: randomUUID() }))
      .rejects.toThrow('profile_import_plugin_publish_journal_unsafe')
    expect(await readdir(directory)).toEqual([`${input.operationId}.1.json`])
  })

  it('persists an immutable switch and rollback history across journal instances', async () => {
    const { root, journal, input } = await fixture()
    const prepared = await journal.create(input)
    expect(await new FileProfileImportPluginPublishJournal(join(root, 'plugin-publish'), uid)
      .load(input.operationId)).toEqual(prepared)
    const switching = await journal.advance(prepared, 'switching')
    await expect(journal.advance(prepared, 'switching'))
      .rejects.toThrow('profile_import_plugin_publish_journal_stale')
    const published = await journal.advance(switching, 'published')
    const rollingBack = await journal.advance(published, 'rolling_back')
    const rolledBack = await journal.advance(rollingBack, 'rolled_back')
    expect(await journal.load(input.operationId)).toEqual(rolledBack)
    await expect(journal.advance(rolledBack, 'switching'))
      .rejects.toThrow('profile_import_plugin_publish_journal_state')
    await expect(journal.create(input)).rejects.toThrow('profile_import_plugin_publish_journal_stale')
  })

  it('reloads the largest valid plugin selection after restart', async () => {
    const { root, journal, input } = await fixture()
    const selectedPluginNames = Array.from({ length: 128 }, (_, index) =>
      `plugin-${String(index).padStart(3, '0')}-${'x'.repeat(203)}`)
    const prepared = await journal.create({ ...input, selectedPluginNames })
    const path = join(root, 'plugin-publish', `${input.operationId}.1.json`)
    expect((await readFile(path)).byteLength).toBeGreaterThan(4096)
    const restarted = new FileProfileImportPluginPublishJournal(join(root, 'plugin-publish'), uid)
    expect(await restarted.load(input.operationId)).toEqual(prepared)
    const switching = await restarted.advance(prepared, 'switching')
    expect(await journal.load(input.operationId)).toEqual(switching)

    const escapedNames = Array.from({ length: 128 }, (_, index) =>
      `plugin-${String(index).padStart(3, '0')}-${'\u0001'.repeat(203)}`)
    const escapedInput = { ...input, operationId: randomUUID(), selectedPluginNames: escapedNames }
    const escapedRecord = await journal.create(escapedInput)
    const escapedPath = join(root, 'plugin-publish', `${escapedInput.operationId}.1.json`)
    expect((await readFile(escapedPath)).byteLength).toBeGreaterThan(64 * 1024)
    expect(await restarted.load(escapedInput.operationId)).toEqual(escapedRecord)
  })

  it('refuses an incomplete or non-private latest record', async () => {
    const { root, journal, input } = await fixture()
    const prepared = await journal.create(input)
    const switching = await journal.advance(prepared, 'switching')
    const path = join(root, 'plugin-publish', `${input.operationId}.${switching.revision}.json`)
    const bytes = await readFile(path)
    await writeFile(path, '{')
    await expect(journal.load(input.operationId))
      .rejects.toThrow('profile_import_plugin_publish_journal_invalid')
    await writeFile(path, bytes)
    await chmod(path, 0o644)
    await expect(journal.load(input.operationId))
      .rejects.toThrow('profile_import_plugin_publish_journal_unsafe')
  })
})
