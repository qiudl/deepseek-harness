/** Test-only journal writer; the parent kills it after a real durable operation and reopens it in another process. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openCollaborationRootPlanningJournal } from '../../src/collaboration-root-planning-journal.ts'
import type { CollaborationRootPlanningManifest } from '../../src/collaboration-root-planning-journal.ts'
const [directory, point] = process.argv.slice(2)
if (!directory || !point) throw Error('fixture arguments missing')
const ctx = new Context()
await ctx.plugin(Storage)
const backend = new JsonStorageBackend(directory), original = backend.kv.open.bind(backend.kv)
let writes = 0
async function stop(event: string) {
  process.send?.({ event })
  await new Promise<void>(() => {})
}
backend.kv.open = async (descriptor) => {
  const unit = await original(descriptor), put = unit.putRecord.bind(unit)
  unit.putRecord = async (...args) => {
    writes++
    if (point === 'before-input' && writes === 1) await stop(point)
    await put(...args)
    if ((point === 'after-input' && writes === 1) || (point === 'after-dispatch' && writes === 2) ||
      (point === 'after-output' && writes === 3)) await stop(point)
  }
  return unit
}
ctx.storage.backend.register('json', backend)
const facility = new DomainFacility(ctx, { backend: 'json' }), journal = await openCollaborationRootPlanningJournal(facility)
try {
  if (point === 'recover') process.send?.({ event: 'recovered', records: [...journal.records()] })
  else {
    const input = JSON.parse(await readFile(join(directory, 'new-input.json'), 'utf8')) as CollaborationRootPlanningManifest
    const r = await journal.prepare(input, new AbortController().signal), m = r.manifest
    const consumed = await journal.dispatch(r, { attempt_request_id: m.attempt_request_id,
      namespace_id: m.root.namespace_id, root_task_id: m.root.root_task_id, root_trace_id: m.root.root_trace_id,
      model_snapshot: m.model_snapshot, plan_id: 'fixture-plan', expected_plan_revision: '1', attempt_id: 'fixture-attempt',
      attempt_fence: '2', source_digest: m.root.source_digest, input_manifest_digest: r.input_manifest_digest,
      lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true,
    }, new AbortController().signal)
    await journal.saveOutput(consumed, '{"intent":"discuss"}', new AbortController().signal)
  }
} finally {
  await journal.close(); await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
  process.disconnect?.()
}
