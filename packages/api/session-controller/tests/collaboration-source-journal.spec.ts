import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCollaborationSourceJournal } from '../src/collaboration-source-journal.ts'

const roots: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const input = () => ({
  workspace_id: '12345678-1234-4123-8123-123456789abc', session_id: 'session-1',
  source_message_id: 'message-1', source_revision: '1', original_message: '@Guide · qiu-slark 请分析',
  active_mentions: [{ mention_id: 'mention-1',
    source_span: { source_message_id: 'message-1', source_revision: '1', start: 0, end: 18 },
    display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' },
    binding: { kind: 'resolved' as const, target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) },
  }],
  model_snapshot: { provider: 'deepseek', model: 'chat', configuration_generation: '1', adapter_fingerprint: 'b'.repeat(64) },
})
function sourceFile(root: string) {
  return join(root, 'collaboration_source_v2.json')
}
async function harness(root?: string, hooks?: { beforeWrite?: () => Promise<void>; afterWrite?: () => Promise<void> }) {
  root ??= await mkdtemp(join(tmpdir(), 'req0004-source-journal-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  const open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor)
    const put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      await hooks?.beforeWrite?.()
      await put(table, key, value)
      await hooks?.afterWrite?.()
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  cleanups.push(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() })
  return { root, facility }
}

describe('REQ-20260930-0004 independent Source journal', () => {
  it('publishes frozen source only after disk persistence and reopens the same commit', async () => {
    const { root, facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const body = input()
    const saved = await journal.capture(body, new AbortController().signal)
    body.original_message = 'changed'
    expect(saved.original_message).toContain('@Guide')
    expect(Object.isFrozen(saved.active_mentions[0]?.binding)).toBe(true)
    expect(await readFile(sourceFile(root), 'utf8')).toContain('message-1')
    await journal.close()
    const reopened = await openCollaborationSourceJournal(facility)
    expect(reopened.read(input())).toEqual(saved)
    expect(await reopened.capture(input(), new AbortController().signal)).toEqual(saved)
    await reopened.close()
  })

  it('serializes concurrent duplicate sends and rejects changed payload under the same identity', async () => {
    const { facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const signal = new AbortController().signal
    const [a, b] = await Promise.all([journal.capture(input(), signal), journal.capture(input(), signal)])
    expect(a).toBe(b)
    expect([...journal.sources()]).toHaveLength(1)
    await expect(journal.capture({ ...input(), original_message: '@Guide · qiu-slark 改做开发' }, signal))
      .rejects.toThrow('collaboration_source_payload_conflict')
    await expect(journal.capture({ ...input(), model_snapshot: { ...input().model_snapshot, configuration_generation: '2' } }, signal))
      .rejects.toThrow('collaboration_source_payload_conflict')
    await journal.close()
  })

  it('separates source revisions and sessions, without normal session files', async () => {
    const { root, facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const signal = new AbortController().signal
    await journal.capture(input(), signal)
    await journal.capture({ ...input(), session_id: 'session-2' }, signal)
    const revised = input()
    revised.source_revision = '2'
    revised.active_mentions[0]!.source_span.source_revision = '2'
    await journal.capture(revised, signal)
    expect([...journal.sources()]).toHaveLength(3)
    await expect(readFile(join(root, 'session-1.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await journal.close()
  })

  it('rejects cancelled work before writing, and drains accepted writes before close', async () => {
    const { facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const controller = new AbortController()
    controller.abort()
    await expect(journal.capture(input(), controller.signal)).rejects.toThrow()
    expect([...journal.sources()]).toHaveLength(0)
    const save = journal.capture(input(), new AbortController().signal)
    const close = journal.close()
    expect((await save).source_message_id).toBe('message-1')
    await close
    await expect(journal.capture(input(), new AbortController().signal)).rejects.toThrow('collaboration_source_journal_closed')
  })

  it('rejects broken mention binding and restores no corrupted source', async () => {
    const { root, facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const bad = input()
    bad.active_mentions[0]!.source_span.source_message_id = 'other'
    await expect(journal.capture(bad, new AbortController().signal)).rejects.toThrow('collaboration_source_journal_invalid')
    await journal.capture(input(), new AbortController().signal)
    await journal.close()
    const path = sourceFile(root)
    const bytes = (await readFile(path, 'utf8')).replace('@Guide', '@Other')
    await writeFile(path, bytes)
    await expect(openCollaborationSourceJournal(facility)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('contains uncertain write acknowledgement until disk recovery preserves the original commit', async () => {
    let first = true
    const { root, facility } = await harness(undefined, { afterWrite: async () => {
      if (first) { first = false; throw new Error('lost-write-ack') }
    } })
    const journal = await openCollaborationSourceJournal(facility)
    const signal = new AbortController().signal
    await expect(journal.capture(input(), signal)).rejects.toThrow('lost-write-ack')
    await expect(journal.capture(input(), signal)).rejects.toThrow('collaboration_source_journal_recovery_required')
    expect(() => journal.read(input())).toThrow('collaboration_source_journal_recovery_required')
    const persisted = JSON.parse(await readFile(sourceFile(root), 'utf8')) as { tables: { sources: Record<string, unknown> } }
    const original = Object.values(persisted.tables.sources)[0]
    await journal.close()
    const recovered = await openCollaborationSourceJournal(facility)
    expect(await recovered.capture(input(), signal)).toEqual(original)
    await recovered.close()
  })

  it('keeps an in-flight source invisible and returns its durable receipt after late cancellation', async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { facility } = await harness(undefined, { beforeWrite: async () => { entered(); await gate } })
    const journal = await openCollaborationSourceJournal(facility)
    const controller = new AbortController()
    const body = input()
    const pending = journal.capture(body, controller.signal)
    body.original_message = 'later mutation'
    await started
    expect(journal.read(input())).toBeUndefined()
    controller.abort()
    release()
    const receipt = await pending
    expect(receipt.original_message).toContain('@Guide')
    expect(journal.read(input())).toBe(receipt)
    await journal.close()
  })

  it.each(['{broken JSON', '{"unit":{"name":"collaboration_source_v2","version":99},"tables":{},"global":null}'])
  ('keeps malformed or foreign-version journal bytes and rejects open: %s', async (bytes) => {
    const { root, facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    await journal.capture(input(), new AbortController().signal)
    await journal.close()
    const path = sourceFile(root)
    await writeFile(path, bytes)
    await expect(openCollaborationSourceJournal(facility)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('bounds pending Sources without dropping existing identities, including after reopen', async () => {
    const { facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const signal = new AbortController().signal
    const original = await journal.capture(input(), signal)
    await Promise.all(Array.from({ length: 127 }, (_, n) => journal.capture({ ...input(), session_id: `session-${n + 2}` }, signal)))
    await expect(journal.capture({ ...input(), session_id: 'overflow' }, signal))
      .rejects.toThrow('collaboration_source_journal_capacity_reached')
    expect(await journal.capture(input(), signal)).toBe(original)
    await journal.close()
    const restored = await openCollaborationSourceJournal(facility)
    expect([...restored.sources()]).toHaveLength(128)
    await expect(restored.capture({ ...input(), session_id: 'overflow' }, signal))
      .rejects.toThrow('collaboration_source_journal_capacity_reached')
    expect(await restored.capture(input(), signal)).toEqual(original)
    await restored.close()
  })

  it('enforces raw UTF-8 budget at the exact multibyte boundary', async () => {
    const { facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const body = input()
    body.original_message = '@A' + '中'.repeat(10_922)
    body.active_mentions[0]!.source_span.end = 2
    const signal = new AbortController().signal
    expect(Buffer.byteLength((await journal.capture(body, signal)).original_message)).toBe(32 * 1024)
    await expect(journal.capture({ ...body, original_message: body.original_message + '中' }, signal))
      .rejects.toThrow('collaboration_source_journal_invalid')
    await journal.close()
  })

  it('rejects invalid numeric generations through the schema rather than leaking BigInt errors', async () => {
    const { facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    await expect(journal.capture({ ...input(), model_snapshot: { ...input().model_snapshot, configuration_generation: 'invalid' } },
      new AbortController().signal)).rejects.toThrow('collaboration_source_journal_invalid')
    await journal.close()
  })

  it('retains ambiguous mention candidates but rejects duplicate candidate handles', async () => {
    const { root, facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const body = { ...input(), active_mentions: [{ ...input().active_mentions[0]!,
      binding: { kind: 'ambiguous' as const, candidate_handles: ['candidate-a', 'candidate-b'] } }] }
    const signal = new AbortController().signal
    expect((await journal.capture(body, signal)).active_mentions[0]?.binding).toEqual(body.active_mentions[0]!.binding)
    const bytes = await readFile(sourceFile(root))
    await expect(journal.capture({ ...body, active_mentions: [{ ...body.active_mentions[0]!,
      binding: { kind: 'ambiguous', candidate_handles: ['candidate-a', 'candidate-a'] } }] }, signal))
      .rejects.toThrow('collaboration_source_journal_invalid')
    expect(await readFile(sourceFile(root))).toEqual(bytes)
    await journal.close()
  })

  it('accepts disjoint classified spans and rejects surrogate splits, malformed text and overlaps', async () => {
    const { root, facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const mention = input().active_mentions[0]!
    const body = { ...input(), original_message: '@A😀 @B', active_mentions: [
      { ...mention, mention_id: 'mention-b', source_span: { ...mention.source_span, start: 5, end: 7 } },
      { ...mention, source_span: { ...mention.source_span, start: 0, end: 2 } },
    ] }
    const signal = new AbortController().signal
    expect((await journal.capture(body, signal)).original_message).toBe(body.original_message)
    const bytes = await readFile(sourceFile(root))
    for (const text of ['@A😀', '@A\uD83D@', '@A\uD83D\uE000']) {
      await expect(journal.capture({ ...input(), original_message: text,
        active_mentions: [{ ...mention, source_span: { ...mention.source_span, end: 3 } }] }, signal))
        .rejects.toThrow('collaboration_source_journal_invalid')
    }
    await expect(journal.capture({ ...body, original_message: '@A@B', active_mentions: [
      { ...mention, source_span: { ...mention.source_span, start: 0, end: 4 } },
      { ...mention, mention_id: 'mention-b', source_span: { ...mention.source_span, start: 2, end: 4 } },
    ] }, signal)).rejects.toThrow('collaboration_source_journal_invalid')
    expect(await readFile(sourceFile(root))).toEqual(bytes)
    await journal.close()
  })

  it('rejects an explicitly undefined reasoning choice before writing a Source', async () => {
    const { facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    await expect(journal.capture({ ...input(), model_snapshot: { ...input().model_snapshot, reasoning_effort: undefined } },
      new AbortController().signal)).rejects.toThrow('collaboration_source_journal_invalid')
    expect([...journal.sources()]).toHaveLength(0)
    await journal.close()
  })

  it('keeps a valid snapshot moved under a wrong storage key and refuses recovery', async () => {
    const { root, facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const saved = await journal.capture(input(), new AbortController().signal)
    await journal.close()
    const path = sourceFile(root), original = await readFile(path, 'utf8')
    const file = JSON.parse(original) as { tables: { sources: Record<string, unknown> } }
    const key = Object.keys(file.tables.sources)[0]!
    file.tables.sources = { 'wrong-key': file.tables.sources[key] }
    const bytes = JSON.stringify(file)
    await writeFile(path, bytes)
    await expect(openCollaborationSourceJournal(facility)).rejects.toThrow('collaboration_source_journal_invalid')
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await writeFile(path, original)
    const restored = await openCollaborationSourceJournal(facility)
    expect(restored.read(input())).toEqual(saved)
    await restored.close()
  })

  it('normalizes a non-Error cancellation without writing or discarding its cause', async () => {
    const { facility } = await harness()
    const journal = await openCollaborationSourceJournal(facility)
    const caller = new AbortController()
    caller.abort('caller expired')
    await expect(journal.capture(input(), caller.signal)).rejects.toMatchObject({
      message: 'collaboration_source_journal_invalid', cause: 'caller expired',
    })
    expect([...journal.sources()]).toHaveLength(0)
    await journal.close()
  })
})
