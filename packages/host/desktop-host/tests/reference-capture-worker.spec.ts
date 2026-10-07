import { expect, it, onTestFinished } from 'vitest'
import { parseHostCollaborationReferenceSelection, parseHostCollaborationReferenceContentTarget,
  parseHostCollaborationReferenceContentChunk } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { ProfileWorkerSupervisor, collaborationWorkerReaders } from '../src/worker-supervisor.ts'
import type { ProfileWorkerHandle } from '../src/types.ts'
const selection = () => parseHostCollaborationReferenceSelection({
  source: { workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'session', source_message_id: 'message', revision: '1' },
  reference_request_id: 'reference-1', source_kind: 'message', source_locator: 'message-0', source_version: '1',
  range: { unit: 'whole' }, recipient_mention_ids: ['mention-1'],
  source_evidence_spans: [{ source_message_id: 'message', source_revision: '1', start: 0, end: 10 }],
})
const spec = { profileId: 'owned-fixture', profileRoot: '/owned-fixture', credentialHandle: 'fixture-key', pluginRoots: [] }
async function fixture(capture?: ProfileWorkerHandle['captureCollaborationReferenceSelection'],
  read?: ProfileWorkerHandle['readCollaborationReferenceContent']) {
  const supervisor = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    ...(capture ? { captureCollaborationReferenceSelection: capture } : {}),
    ...(read ? { readCollaborationReferenceContent: read } : {}),
  }))
  onTestFinished(() => supervisor.disposeAll())
  await supervisor.start(spec)
  return supervisor
}
it('the startup readers forward an authorized selection only to its original running worker', async () => {
  const calls: unknown[] = [], reply = { reference_request_digest: 'fixture' }
  const supervisor = await fixture(async (input, signal) => { calls.push(input); expect(signal.aborted).toBe(false); return reply })
  const capture = collaborationWorkerReaders(supervisor).captureCollaborationReferenceSelection!
  expect(await capture(spec.profileId, selection(), new AbortController().signal)).toEqual(reply)
  expect(calls).toEqual([selection()])
  await expect(capture('other-profile', selection(), new AbortController().signal)).rejects.toThrow('unavailable')
  expect(calls).toHaveLength(1)
})
it('rejects missing readers, already cancelled calls and a closed supervisor without invoking a worker', async () => {
  const missing = await fixture(), controller = new AbortController(); controller.abort()
  await expect(missing.captureCollaborationReferenceSelection(spec.profileId, selection(), new AbortController().signal)).rejects.toThrow('unavailable')
  let calls = 0
  const supervisor = await fixture(async () => { calls++; return null })
  await expect(supervisor.captureCollaborationReferenceSelection(spec.profileId, selection(), controller.signal)).rejects.toThrow()
  await supervisor.disposeAll()
  await expect(supervisor.captureCollaborationReferenceSelection(spec.profileId, selection(), new AbortController().signal)).rejects.toThrow('unavailable')
  expect(calls).toBe(0)
})
for (const mode of ['disposed', 'replaced', 'cancelled', 'closed'] as const) {
  it(`withholds a worker response after it becomes ${mode}`, async () => {
    let enter = () => {}, release = (_value: HostRemoteSessionJson) => {}
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const supervisor = await fixture(async () => { enter(); return new Promise((resolve) => { release = resolve }) })
    const controller = new AbortController()
    const pending = supervisor.captureCollaborationReferenceSelection(spec.profileId, selection(), controller.signal)
    await entered
    if (mode === 'closed') await supervisor.disposeAll()
    if (mode === 'cancelled') controller.abort()
    if (mode === 'disposed' || mode === 'replaced') await supervisor.dispose(spec.profileId)
    if (mode === 'replaced') await supervisor.start(spec)
    release(null)
    await expect(pending).rejects.toThrow()
  })
}

function contentTarget() {
  const source = selection().source
  return parseHostCollaborationReferenceContentTarget({ workspace_id: source.workspace_id, session_id: source.session_id,
    source_message_id: source.source_message_id, source_revision: source.revision, reference_request_digest: 'b'.repeat(64), offset: 0 })
}
function emptyContent() {
  const { offset, reference_request_digest, ...source } = contentTarget()
  return parseHostCollaborationReferenceContentChunk({ descriptor: { ...source, snapshot_digest: 'a'.repeat(64) },
    reference_request_digest, content_digest: 'c'.repeat(64), offset, total_bytes: 0, chunk_base64url: '' })
}
it('startup readers use the independent content worker only while it is current', async () => {
  const calls: unknown[] = [], supervisor = await fixture(undefined, async (target) => { calls.push(target); return emptyContent() })
  const read = collaborationWorkerReaders(supervisor).readCollaborationReferenceContent!
  expect(await read(spec.profileId, contentTarget(), new AbortController().signal)).toEqual(emptyContent())
  expect(calls).toEqual([contentTarget()])
  await expect(read('other', contentTarget(), new AbortController().signal)).rejects.toThrow('unavailable')
  await expect(read(spec.profileId, contentTarget(), AbortSignal.abort())).rejects.toThrow()
  await supervisor.disposeAll()
  await expect(read(spec.profileId, contentTarget(), new AbortController().signal)).rejects.toThrow('unavailable')
  const missing = await fixture()
  await expect(missing.readCollaborationReferenceContent(spec.profileId, contentTarget(), new AbortController().signal)).rejects.toThrow('unavailable')
})
for (const mode of ['disposed', 'replaced', 'cancelled', 'closed'] as const) {
  it(`withholds selected-byte chunks after the worker is ${mode}`, async () => {
    const entered = Promise.withResolvers<undefined>(), returned = Promise.withResolvers<ReturnType<typeof emptyContent>>()
    const supervisor = await fixture(undefined, async () => { entered.resolve(undefined); return returned.promise })
    const controller = new AbortController()
    const pending = supervisor.readCollaborationReferenceContent(spec.profileId, contentTarget(), controller.signal)
    await entered.promise
    if (mode === 'closed') await supervisor.disposeAll()
    if (mode === 'cancelled') controller.abort()
    if (mode === 'disposed' || mode === 'replaced') await supervisor.dispose(spec.profileId)
    if (mode === 'replaced') await supervisor.start(spec)
    returned.resolve(emptyContent())
    await expect(pending).rejects.toThrow()
  })
}
