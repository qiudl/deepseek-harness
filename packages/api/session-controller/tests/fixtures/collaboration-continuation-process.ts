/** Source-mode child killed by its owner at an observation journal write boundary. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { parseCollaborationConsumptionRecord } from '../../src/collaboration-consumption-journal.ts'
import { openCollaborationContinuationJournal } from '../../src/collaboration-continuation-journal.ts'
const [directory, point] = process.argv.slice(2)
if (!directory || !point) throw Error('fixture arguments missing')
const ctx = new Context()
await ctx.plugin(Storage)
const backend = new JsonStorageBackend(directory), original = backend.kv.open.bind(backend.kv)
async function stop() { process.send?.({ event: point }); await new Promise<void>(() => {}) }
backend.kv.open = async (descriptor) => {
  const unit = await original(descriptor), put = unit.putRecord.bind(unit)
  if (descriptor.name === 'collaboration_continuation_v1') unit.putRecord = async (...args) => {
    if (point === 'before-write') await stop()
    await put(...args)
    if (point === 'after-write') await stop()
  }
  return unit
}
ctx.storage.backend.register('json', backend)
const facility = new DomainFacility(ctx, { backend: 'json' })
const journal = await openCollaborationContinuationJournal(facility)
try {
  const input = JSON.parse(await readFile(join(directory, 'continuation-input.json'), 'utf8')) as {
    record: unknown
    sessionId: string
    events: SessionEvent[]
    message: UserMessage
  }
  const entry = await journal.observe(parseCollaborationConsumptionRecord(input.record), SessionId(input.sessionId),
    input.events, input.message, new AbortController().signal)
  process.send?.({ event: 'recovered', entry })
} finally {
  await journal.close(); await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); process.disconnect?.()
}
