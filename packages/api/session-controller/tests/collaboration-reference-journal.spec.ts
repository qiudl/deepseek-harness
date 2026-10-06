import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { expect, it, onTestFinished } from 'vitest'
import { collaborationJournalDigest, describeCollaborationSource, openCollaborationSourceJournal } from '../src/collaboration-source-journal.ts'
import * as referenceCapture from '../src/collaboration-reference-journal.ts'
import { captureCollaborationReferenceContent, openCollaborationReferenceJournal, parseCollaborationReferenceRequest } from '../src/collaboration-reference-journal.ts'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
async function fixture(hooks?: { before?: () => Promise<void>; after?: () => Promise<void> }) {
  const root = await mkdtemp(join(tmpdir(), 'req0004-reference-journal-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  onTestFinished(() => backend.close())
  ctx.storage.backend.register('json', backend)
  let referenceWrites = false
  const open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      if (referenceWrites) await hooks?.before?.()
      await put(table, key, value)
      if (referenceWrites) await hooks?.after?.()
    }
    return unit
  }
  const facility = new DomainFacility(ctx, { backend: 'json' })
  onTestFinished(() => facility.closeAll())
  const journal = await openCollaborationSourceJournal(facility)
  onTestFinished(() => journal.close())
  const original = '@Guide · qiu-slark 请引用前面那条范围说明并分析'
  const source = await journal.capture({ workspace_id: randomUUID(), session_id: 'session-1', source_message_id: 'source-1',
    source_revision: '1', original_message: original,
    active_mentions: [{ mention_id: 'mention-1', source_span: { source_message_id: 'source-1', source_revision: '1',
      start: 0, end: '@Guide · qiu-slark'.length }, display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' },
    binding: { kind: 'resolved', target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }],
    model_snapshot: { provider: 'deepseek', model: 'chat', configuration_generation: '1', adapter_fingerprint: 'b'.repeat(64) },
  }, new AbortController().signal)
  referenceWrites = true
  const text = '\ufeff范围😀\r\n仅限这个项目'
  const request = () => ({ source: { workspace_id: source.workspace_id, session_id: source.session_id,
    source_message_id: source.source_message_id, revision: source.source_revision, message_digest: sha(source.original_message) },
  reference_request_id: 'ref-1', source_kind: 'message' as const, source_locator: 'previous-message', source_version: '1',
  range: { start: 0, end: text.length, unit: 'utf16' as const }, mime_type: 'text/plain', content_digest: sha(text),
  byte_length: Buffer.byteLength(text), recipient_mention_ids: ['mention-1'],
  source_evidence_spans: [{ source_message_id: source.source_message_id,
    source_revision: source.source_revision, start: 0, end: original.length }] })
  const content = (value = text) => ({ source_kind: 'message' as const, source_locator: 'previous-message', source_version: '1',
    mime_type: 'text/plain', chunks: (async function* () { yield Buffer.from(value) })() })
  return { root, facility, source, text, request, content }
}

it('captures independently read exact content, persists it and reopens the same reference grant', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const captured = await captureCollaborationReferenceContent(f.request(), f.source, async () => f.content(), signal)
  const journal = await openCollaborationReferenceJournal(f.facility)
  const saved = await journal.capture(captured, signal)
  expect(Buffer.from(saved.content_base64, 'base64').toString()).toBe(f.text)
  expect(saved.request).toEqual(f.request())
  expect(saved.reference_request_digest).toBe(collaborationJournalDigest(f.request()))
  expect(Object.isFrozen(saved.request.recipient_mention_ids)).toBe(true)
  expect(journal.read(f.source, saved.reference_request_digest)).toBe(saved)
  expect(await readFile(join(f.root, 'collaboration_reference_v2.json'), 'utf8')).toContain('previous-message')
  await journal.close()
  const reopened = await openCollaborationReferenceJournal(f.facility)
  expect(reopened.read(f.source, saved.reference_request_digest)).toEqual(saved)
  expect(await reopened.capture(captured, signal)).toEqual(saved)
  await reopened.close()
})

it('does not create a grant from a Source digest, a challenge digest or foreign recipients', async () => {
  const f = await fixture(), signal = new AbortController().signal
  let reads = 0
  const read = async () => { reads++; return f.content() }
  for (const change of [{ source: { ...f.request().source, session_id: 'foreign' } },
    { source: { ...f.request().source, message_digest: 'c'.repeat(64) } }, { recipient_mention_ids: ['unmentioned'] },
    { source_evidence_spans: [{ ...f.request().source_evidence_spans[0]!, source_message_id: 'other' }] },
    { reference_request_digest: 'c'.repeat(64) }, { host_snapshot_assertion: 'shape-only' }]) {
    await expect(captureCollaborationReferenceContent({ ...f.request(), ...change }, f.source, read, signal)).rejects.toThrow()
  }
  expect(reads).toBe(0)
  const journal = await openCollaborationReferenceJournal(f.facility)
  expect(journal.read(f.source, describeCollaborationSource(f.source).snapshot_digest)).toBeUndefined()
  await journal.close()
})

it('refuses changed source version, locator, media type and selected content after the independent read', async () => {
  const f = await fixture(), signal = new AbortController().signal
  for (const change of [{ source_version: '2' }, { source_locator: 'other' }, { mime_type: 'application/json' }])
    await expect(captureCollaborationReferenceContent(f.request(), f.source, async () => ({ ...f.content(), ...change }), signal))
      .rejects.toThrow('collaboration_reference_source_changed')
  await expect(captureCollaborationReferenceContent(f.request(), f.source, async () => f.content('changed'), signal)).rejects.toThrow()
})

it('retains only the selected UTF-16 range across split UTF-8 chunks without normalizing BOM or newlines', async () => {
  const f = await fixture(), signal = new AbortController().signal, bytes = Buffer.from(f.text)
  const selected = f.text.slice(1, 5), request = { ...f.request(), range: { start: 1, end: 5, unit: 'utf16' },
    content_digest: sha(selected), byte_length: Buffer.byteLength(selected) }
  const captured = await captureCollaborationReferenceContent(request, f.source, async () => ({ ...f.content(),
    chunks: (async function* () { for (const byte of bytes) yield Uint8Array.of(byte) })() }), signal)
  expect(Buffer.from(captured.content_base64, 'base64').toString()).toBe(selected)
})

it('refuses surrogate splits, out-of-range content and malformed textual bytes', async () => {
  const f = await fixture(), signal = new AbortController().signal
  for (const range of [{ start: 3, end: 4, unit: 'utf16' },
    { start: 0, end: f.text.length + 1, unit: 'utf16' }])
    await expect(captureCollaborationReferenceContent({ ...f.request(), range }, f.source,
      async () => f.content(), signal)).rejects.toThrow()
  await expect(captureCollaborationReferenceContent(f.request(), f.source, async () => ({ ...f.content(),
    chunks: (async function* () { yield Uint8Array.of(0xff) })() }), signal)).rejects.toThrow()
})

it('checks cancellation before reading and awaits stream disposal after cancellation during extraction', async () => {
  const f = await fixture(), controller = new AbortController()
  controller.abort()
  let reads = 0, closed = false
  await expect(captureCollaborationReferenceContent(f.request(), f.source, async () => { reads++; return f.content() }, controller.signal))
    .rejects.toThrow()
  expect(reads).toBe(0)
  const active = new AbortController()
  await expect(captureCollaborationReferenceContent(f.request(), f.source, async () => ({ ...f.content(), chunks: (async function* () {
    try { yield Buffer.from(f.text); active.abort(); yield Uint8Array.of(1) } finally { closed = true }
  })() }), active.signal)).rejects.toThrow()
  expect(closed).toBe(true)
})

it('deduplicates concurrent captures and never grants the same digest to another Source generation', async () => {
  const f = await fixture(), signal = new AbortController().signal, journal = await openCollaborationReferenceJournal(f.facility)
  const captured = await captureCollaborationReferenceContent(f.request(), f.source, async () => f.content(), signal)
  const [a, b] = await Promise.all([journal.capture(captured, signal), journal.capture(captured, signal)])
  expect(a).toBe(b)
  const { host_journal_commit, ...body } = f.source
  const foreign = { ...body, session_id: 'other' }
  expect(journal.read({ ...foreign, host_journal_commit: { ...host_journal_commit,
    content_digest: collaborationJournalDigest(foreign) } }, a.reference_request_digest)).toBeUndefined()
  expect(journal.read(f.source, 'c'.repeat(64))).toBeUndefined()
  await expect(journal.capture({ ...captured, request: { ...captured.request, reference_request_id: 'ref-1',
    source_locator: 'changed' } }, signal)).rejects.toThrow()
  await journal.close()
})

it('refuses tampered persisted bytes while retaining the original file for diagnosis', async () => {
  const f = await fixture(), signal = new AbortController().signal, journal = await openCollaborationReferenceJournal(f.facility)
  await journal.capture(await captureCollaborationReferenceContent(f.request(), f.source, async () => f.content(), signal), signal)
  await journal.close()
  const path = join(f.root, 'collaboration_reference_v2.json')
  const data = JSON.parse(await readFile(path, 'utf8')) as { tables: { references: Record<string, { content_base64: string }> } }
  const record = Object.values(data.tables.references)[0]!
  record.content_base64 = Buffer.from('changed').toString('base64')
  const broken = JSON.stringify(data)
  await writeFile(path, broken)
  await expect(openCollaborationReferenceJournal(f.facility)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(broken)
})

it('refuses a persisted textual byte selection containing invalid UTF-8 even with matching digests', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const request = { ...f.request(), source_kind: 'file' as const,
    range: { start: 0, end: 1, unit: 'byte' as const }, byte_length: 1,
    mime_type: 'text/plain', content_digest: sha(Uint8Array.of(255)) }
  const journal = await openCollaborationReferenceJournal(f.facility)
  await expect(journal.capture({ schema_version: 1, descriptor: describeCollaborationSource(f.source), request,
    reference_request_digest: collaborationJournalDigest(request), content_base64: '/w==' }, signal)).rejects.toThrow()
  expect(journal.read(f.source, collaborationJournalDigest(request))).toBeUndefined()
  await journal.close()
})

it('detaches request metadata and rejects content injection before a Profile read', async () => {
  const f = await fixture(), value = f.request(), parsed = parseCollaborationReferenceRequest(value)
  value.range.end = 0
  expect(parsed.range.end).toBe(f.text.length)
  expect(Object.isFrozen(parsed.source)).toBe(true)
  expect(() => parseCollaborationReferenceRequest({ ...f.request(), content: 'forged' })).toThrow()
})
it('extracts a bounded binary byte range and completes the full source iterator', async () => {
  const f = await fixture(), signal = new AbortController().signal, payload = Uint8Array.of(0, 255, 128, 1)
  const selected = payload.subarray(1, 3)
  const request = { ...f.request(), source_kind: 'file' as const, mime_type: 'application/octet-stream',
    range: { start: 1, end: 3, unit: 'byte' as const }, byte_length: 2, content_digest: sha(selected) }
  let completed = false
  const captured = await captureCollaborationReferenceContent(request, f.source, async () => ({ ...f.content(),
    source_kind: 'file', mime_type: request.mime_type,
    chunks: (async function* () { for (const byte of payload) yield Uint8Array.of(byte); completed = true })() }), signal)
  expect(Buffer.from(captured.content_base64, 'base64')).toEqual(Buffer.from(selected))
  expect(completed).toBe(true)
})
it('refuses truncated ranges and surrogate splits after valid selection metadata reaches the reader', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const split = { ...f.request(), range: { start: 3, end: 4, unit: 'utf16' as const },
    byte_length: 3, content_digest: sha('x') }
  await expect(captureCollaborationReferenceContent(split, f.source, async () => f.content(), signal))
    .rejects.toThrow('collaboration_reference_range_invalid')
  const missing = { ...f.request(), range: { start: 0, end: f.text.length + 1, unit: 'utf16' as const } }
  await expect(captureCollaborationReferenceContent(missing, f.source, async () => f.content(), signal))
    .rejects.toThrow('collaboration_reference_range_invalid')
})
it('refuses a changed selection under one retained identity and refuses writes after close', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const a = await captureCollaborationReferenceContent(f.request(), f.source, async () => f.content(), signal)
  const journal = await openCollaborationReferenceJournal(f.facility)
  await journal.capture(a, signal)
  const request = { ...f.request(), source_locator: 'another-message' }
  const changed = await captureCollaborationReferenceContent(request, f.source,
    async () => ({ ...f.content(), source_locator: request.source_locator }), signal)
  await expect(journal.capture(changed, signal)).rejects.toThrow('collaboration_reference_payload_conflict')
  await journal.close()
  await expect(journal.capture(a, signal)).rejects.toThrow('collaboration_reference_journal_closed')
  expect(() => journal.read(f.source, a.reference_request_digest)).toThrow('collaboration_reference_journal_closed')
})
it('requires reopen after an uncertain durable write and recovers the exact first record', async () => {
  let fail = true
  const f = await fixture({ after: async () => { if (fail) { fail = false; throw Error('lost-ack') } } })
  const signal = new AbortController().signal
  const record = await captureCollaborationReferenceContent(f.request(), f.source, async () => f.content(), signal)
  const journal = await openCollaborationReferenceJournal(f.facility)
  await expect(journal.capture(record, signal)).rejects.toThrow('lost-ack')
  expect(() => journal.read(f.source, record.reference_request_digest)).toThrow('collaboration_reference_journal_recovery_required')
  await expect(journal.capture(record, signal)).rejects.toThrow('collaboration_reference_journal_recovery_required')
  await journal.close()
  const next = await openCollaborationReferenceJournal(f.facility)
  expect(await next.capture(record, signal)).toEqual(record)
  await next.close()
})
it('refuses a ninth selection for the same immutable Source without evicting committed content', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const journal = await openCollaborationReferenceJournal(f.facility)
  for (let index = 0; index < 9; index++) {
    const record = await captureCollaborationReferenceContent({ ...f.request(), reference_request_id: `ref-${index}` },
      f.source, async () => f.content(), signal)
    if (index < 8) await journal.capture(record, signal)
    else await expect(journal.capture(record, signal)).rejects.toThrow('collaboration_reference_capacity_reached')
  }
  await journal.close()
})

it('checks cancellation immediately after independent content lookup without consuming its stream', async () => {
  const f = await fixture(), cancel = new AbortController()
  await expect(captureCollaborationReferenceContent(f.request(), f.source, async () => {
    cancel.abort(); return f.content()
  }, cancel.signal)).rejects.toThrow()
})
it('wraps a primitive cancellation reason at the durable write entry', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const record = await captureCollaborationReferenceContent(f.request(), f.source, async () => f.content(), signal)
  const journal = await openCollaborationReferenceJournal(f.facility)
  await expect(journal.capture(record, AbortSignal.abort('cancelled'))).rejects.toMatchObject({ cause: 'cancelled' })
  await journal.close()
})
it('rejects a changed persisted key even when the selection and content remain valid', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const record = await captureCollaborationReferenceContent(f.request(), f.source, async () => f.content(), signal)
  const journal = await openCollaborationReferenceJournal(f.facility)
  await journal.capture(record, signal)
  await journal.close()
  const path = join(f.root, 'collaboration_reference_v2.json')
  const data = JSON.parse(await readFile(path, 'utf8')) as { tables: { references: Record<string, typeof record> } }
  data.tables.references = { changed: record }
  const broken = JSON.stringify(data)
  await writeFile(path, broken)
  await expect(openCollaborationReferenceJournal(f.facility)).rejects.toThrow('collaboration_reference_journal_invalid')
  expect(await readFile(path, 'utf8')).toBe(broken)
})

it('refuses actual UTF-8 content exceeding the declared selected byte length', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const text = 'é'.repeat(f.text.length)
  await expect(captureCollaborationReferenceContent({ ...f.request(), byte_length: f.text.length }, f.source,
    async () => f.content(text), signal)).rejects.toThrow('collaboration_reference_content_changed')
})

function wholeSelection(f: Awaited<ReturnType<typeof fixture>>) {
  const { mime_type: _mime, content_digest: _digest, byte_length: _bytes, ...request } = f.request()
  const { message_digest: _sourceDigest, ...source } = request.source
  return { ...request, source, range: { unit: 'whole' as const } }
}
it('generates immutable reservation metadata from actual whole-message bytes without caller digests', async () => {
  const f = await fixture(), selection = wholeSelection(f), signal = new AbortController().signal
  const captured = await referenceCapture.captureCollaborationReferenceSelectionContent(
    selection, f.source, async () => f.content(), signal,
  )
  expect(captured.request).toEqual(f.request())
  expect(Buffer.from(captured.content_base64, 'base64').toString()).toBe(f.text)
  expect(captured.reference_request_digest).toBe(collaborationJournalDigest(f.request()))
  expect(Object.isFrozen(captured.request)).toBe(true)
})
it('generates a precise selected range and independently derived binary media type', async () => {
  const f = await fixture(), signal = new AbortController().signal, payload = Uint8Array.of(0, 255, 128, 1)
  const selection = { ...wholeSelection(f), source_kind: 'file', range: { start: 1, end: 3, unit: 'byte' } }
  const captured = await referenceCapture.captureCollaborationReferenceSelectionContent(selection, f.source, async () => ({
    ...f.content(), source_kind: 'file', mime_type: 'application/octet-stream',
    chunks: (async function* () { yield payload })(),
  }), signal)
  expect(captured.request.range).toEqual(selection.range)
  expect(captured.request.mime_type).toBe('application/octet-stream')
  expect(captured.request.byte_length).toBe(2)
  expect(captured.request.content_digest).toBe(sha(payload.subarray(1, 3)))
  expect(Buffer.from(captured.content_base64, 'base64')).toEqual(Buffer.from(payload.subarray(1, 3)))
})
it('refuses caller content, digests, paths, invalid recipients and stale Sources before selection reads', async () => {
  const f = await fixture(), signal = new AbortController().signal
  let reads = 0
  for (const change of [{ content: 'injected' }, { content_digest: 'a'.repeat(64) }, { mime_type: 'text/plain' },
    { source_locator: '/private/file' }, { recipient_mention_ids: ['unmentioned'] },
    { source: { ...wholeSelection(f).source, session_id: 'foreign' } }])
    await expect(referenceCapture.captureCollaborationReferenceSelectionContent({ ...wholeSelection(f), ...change }, f.source,
      async () => { reads++; return f.content() }, signal)).rejects.toThrow()
  expect(reads).toBe(0)
})
it('rejects an oversized whole file while disposing its independent source stream', async () => {
  const f = await fixture(), signal = new AbortController().signal
  let closed = false
  const selection = { ...wholeSelection(f), source_kind: 'file' }
  await expect(referenceCapture.captureCollaborationReferenceSelectionContent(selection, f.source, async () => ({
    ...f.content(), source_kind: 'file', mime_type: 'application/octet-stream',
    chunks: (async function* () { try { yield Buffer.alloc(1024 * 1024 + 1) } finally { closed = true } })(),
  }), signal)).rejects.toThrow('collaboration_reference_content_changed')
  expect(closed).toBe(true)
})

it('exports only validated computed metadata and refuses altered digests or leaked content fields', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const record = await referenceCapture.captureCollaborationReferenceSelectionContent(
    wholeSelection(f), f.source, async () => f.content(), signal,
  )
  const metadata = referenceCapture.describeCollaborationReference(record)
  expect(referenceCapture.parseCollaborationReferenceMetadata(metadata)).toEqual(metadata)
  expect(Object.hasOwn(metadata, 'content_base64')).toBe(false)
  expect(Object.isFrozen(metadata)).toBe(true)
  for (const change of [{ reference_request_digest: 'c'.repeat(64) }, { content_base64: record.content_base64 },
    { descriptor: { ...metadata.descriptor, session_id: 'foreign' } }])
    expect(() => referenceCapture.parseCollaborationReferenceMetadata({ ...metadata, ...change })).toThrow()
})
