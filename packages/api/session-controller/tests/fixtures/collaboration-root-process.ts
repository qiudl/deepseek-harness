/** Test-only source subprocess; its owner kills it at a durable-write boundary. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CollaborationRootInput } from '../../src/collaboration-root-journal.ts'
import { openCollaborationRootJournal } from '../../src/collaboration-root-journal.ts'
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
    if (point === 'before-root-write' && writes === 1) await stop(point)
    await put(...args)
    if (point === 'after-root-write' && writes === 1) await stop(point)
    if (point === 'after-receipt-write' && writes === 2) await stop(point)
  }
  return unit
}
ctx.storage.backend.register('json', backend)
const facility = new DomainFacility(ctx, { backend: 'json' })
const journal = await openCollaborationRootJournal(facility)
try {
  const input = JSON.parse(await readFile(join(directory, 'input.json'), 'utf8')) as CollaborationRootInput
  const entry = await journal.capture(input, new AbortController().signal)
  if (point === 'after-root-response') await stop(point)
  if (point === 'after-receipt-write') await journal.accept(entry.command_id, {
    root_task_id: entry.root_task_id, root_trace_id: entry.root_trace_id, admission_id: entry.command_id,
    task_revision: 1, state_version: 1, state: 'active',
  }, new AbortController().signal)
  process.send?.({ event: 'recovered', entry })
} finally {
  await journal.close(); await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
  process.disconnect?.()
}
