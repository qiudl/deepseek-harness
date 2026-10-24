/** REQ-20261022-0022: fenced, resumable directory publication for an internal plugin import. */
import { constants, realpathSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { inspectProfileImportPluginPublishRecovery,
  type FileProfileImportPluginPublishJournal,
  type ProfileImportPluginPublishRecord } from './profile-import-plugin-publish-journal.ts'
import type { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'
import type { SingleHostLock } from './single-instance.ts'

const running = new Set<string>()

export type ProfileImportPluginPublisherInput = Readonly<{
  journal: FileProfileImportPluginPublishJournal
  fence: ProfileImportWorkerFence
  hostLock: SingleHostLock
  profileRoot: string
  operationId: string
  sourceProfileId: string
  targetProfileId: string
  uid: number
  assertAuthority(): Promise<void>
  assertQuiescent(): Promise<void>
  assertPreparedCandidate(): Promise<void>
  assertSessionPointerOld(): Promise<void>
  signal?: AbortSignal
}>

type Input = ProfileImportPluginPublisherInput

async function exclusive<T>(input: Input, action: () => Promise<T>): Promise<T> {
  if (!isAbsolute(input.profileRoot)) throw Error('profile_import_plugin_publish_invalid')
  const key = realpathSync(input.profileRoot)
  if (running.has(key)) throw Error('profile_import_plugin_publish_busy')
  running.add(key)
  try { return await action() } finally { running.delete(key) }
}

async function assertOwner(input: Input): Promise<void> {
  input.signal?.throwIfAborted()
  input.hostLock.assertOwner()
  input.fence.assertOwnedPair(input.sourceProfileId, input.targetProfileId, input.operationId)
  await input.assertQuiescent()
  await input.assertAuthority()
  input.hostLock.assertOwner()
  input.fence.assertOwnedPair(input.sourceProfileId, input.targetProfileId, input.operationId)
}

async function syncParent(profileRoot: string): Promise<void> {
  const handle = await open(join(profileRoot, 'profiles'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function evidence(input: Input) {
  await assertOwner(input)
  return inspectProfileImportPluginPublishRecovery(input)
}

function layerPaths(input: Input) {
  const parent = join(input.profileRoot, 'profiles')
  return {
    web: join(parent, 'web'),
    staged: join(parent, `.web-import-${input.operationId}`),
    backup: join(parent, `.web-import-backup-${input.operationId}`),
  }
}

async function publishLocked(input: Input): Promise<ProfileImportPluginPublishRecord> {
  const { web, staged, backup } = layerPaths(input)
  let current = await evidence(input)
  if (current.action === 'published') return current.record
  await input.assertSessionPointerOld()
  if (current.action === 'ready') {
    await input.assertPreparedCandidate()
    await assertOwner(input)
    if (current.record.phase === 'prepared') {
      await input.journal.advance(current.record, 'switching')
      current = await evidence(input)
    }
    if (current.action !== 'ready') throw Error('profile_import_plugin_publish_changed')
    await input.assertSessionPointerOld()
    await rename(web, backup)
    await syncParent(input.profileRoot)
    current = await evidence(input)
  }
  if (current.action === 'publish_candidate') {
    await assertOwner(input)
    await input.assertSessionPointerOld()
    await rename(staged, web)
    await syncParent(input.profileRoot)
    current = await evidence(input)
  }
  if (current.action !== 'record_published') {
    throw Error('profile_import_plugin_publish_recovery_unknown')
  }
  await assertOwner(input)
  return input.journal.advance(current.record, 'published')
}

/** Publish only the plugin directory; keep both import fences until the Session transaction resolves. */
export async function publishProfileImportPluginLayer(input: Input): Promise<ProfileImportPluginPublishRecord> {
  return exclusive(input, () => publishLocked(input))
}

/** Hold the same Profile mutex through publication and the caller's Session pointer switch. */
export async function publishProfileImportPluginLayerAndCommitSession<T>(input: Input,
  commitSession: (published: ProfileImportPluginPublishRecord) => Promise<T>): Promise<T> {
  return exclusive(input, async () => commitSession(await publishLocked(input)))
}

async function rollbackLocked(input: Input): Promise<ProfileImportPluginPublishRecord> {
  const { web, staged, backup } = layerPaths(input)
  let current = await evidence(input)
  if (current.action === 'rolled_back') return current.record
  await input.assertSessionPointerOld()
  await assertOwner(input)
  if (current.record.phase === 'prepared' || current.record.phase === 'switching'
      || current.record.phase === 'published') {
    current = { record: await input.journal.advance(current.record, 'rolling_back'),
      action: current.action }
    current = await evidence(input)
  }
  if (current.action === 'move_candidate_back') {
    await input.assertSessionPointerOld()
    await assertOwner(input)
    await rename(web, staged)
    await syncParent(input.profileRoot)
    current = await evidence(input)
  }
  if (current.action === 'restore_old') {
    await input.assertSessionPointerOld()
    await assertOwner(input)
    await rename(backup, web)
    await syncParent(input.profileRoot)
    current = await evidence(input)
  }
  if (current.action !== 'record_rolled_back') {
    throw Error('profile_import_plugin_publish_recovery_unknown')
  }
  await input.assertSessionPointerOld()
  await assertOwner(input)
  return input.journal.advance(current.record, 'rolled_back')
}

/** Restore the old plugin directory only while the Session pointer is still on its old generation. */
export async function rollbackProfileImportPluginLayer(input: Input): Promise<ProfileImportPluginPublishRecord> {
  return exclusive(input, () => rollbackLocked(input))
}

/** Hold the Profile mutex through plugin rollback and the caller's staged Session abort. */
export async function rollbackProfileImportPluginLayerAndAbortSession<T>(input: Input,
  abortSession: (rolledBack: ProfileImportPluginPublishRecord) => Promise<T>,
  beforeRollback?: () => Promise<void>): Promise<T> {
  return exclusive(input, async () => {
    if (beforeRollback) { await assertOwner(input); await beforeRollback() }
    return abortSession(await rollbackLocked(input))
  })
}
