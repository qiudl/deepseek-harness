import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

describe('plugin publish intent journal', () => {
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
