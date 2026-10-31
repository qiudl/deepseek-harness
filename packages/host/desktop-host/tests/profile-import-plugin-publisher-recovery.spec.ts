import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ProfileImportPluginPublisherInput } from '../src/profile-import-plugin-publisher.ts'
import { FileProfileImportPluginPublishJournal } from '../src/profile-import-plugin-publish-journal.ts'
import { ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'

const inspect = vi.hoisted(() => vi.fn())
vi.mock('../src/profile-import-plugin-publish-journal.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/profile-import-plugin-publish-journal.ts')>()
  return { ...actual, inspectProfileImportPluginPublishRecovery: inspect }
})

import { publishProfileImportPluginLayer, rollbackProfileImportPluginLayer } from '../src/profile-import-plugin-publisher.ts'

async function fixture() {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-plugin-publisher-recovery-'))
  const uid = process.getuid?.() ?? 0
  const hostLock = await acquireSingleHostLock({ root: join(profileRoot, 'host-lock'), pid: process.pid,
    uid, processNonce: randomUUID() })
  onTestFinished(async () => { await hostLock.release(); await rm(profileRoot, { recursive: true, force: true }) })
  const fence = new ProfileImportWorkerFence({ read: () => undefined, replace: () => {} })
  vi.spyOn(fence, 'assertOwnedPair').mockImplementation(() => {})
  const journal = new FileProfileImportPluginPublishJournal(join(profileRoot, 'journal'), uid)
  vi.spyOn(journal, 'advance').mockImplementation(async (record, phase) => ({ ...record, phase }))
  const input: ProfileImportPluginPublisherInput = { profileRoot, operationId: randomUUID(), sourceProfileId: randomUUID(),
    targetProfileId: randomUUID(), uid, hostLock, fence, journal,
    assertAuthority: async () => {}, assertQuiescent: async () => {},
    assertPreparedCandidate: async () => {}, assertSessionPointerOld: async () => {} }
  return input
}

it('keeps the Profile fenced when publication recovery changes unexpectedly', async () => {
  const input = await fixture()
  const record = { phase: 'prepared' }
  inspect.mockReset().mockResolvedValueOnce({ record, action: 'ready' })
    .mockResolvedValueOnce({ record: { phase: 'switching' }, action: 'published' })
  await expect(publishProfileImportPluginLayer(input))
    .rejects.toThrow('profile_import_plugin_publish_changed')

  inspect.mockReset().mockResolvedValueOnce({ record: { phase: 'switching' }, action: 'restore_old' })
  await expect(publishProfileImportPluginLayer(input))
    .rejects.toThrow('profile_import_plugin_publish_recovery_unknown')

  inspect.mockReset().mockResolvedValueOnce({ record: { phase: 'rolling_back' }, action: 'ready' })
  await expect(rollbackProfileImportPluginLayer(input))
    .rejects.toThrow('profile_import_plugin_publish_recovery_unknown')
})
