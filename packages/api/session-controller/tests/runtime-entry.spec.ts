/** Actual driver + private SQLite effects. Origin-reader inputs here are controlled metadata, not a whole-chain positive. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { parseRuntimeEntryBinding, type RuntimeEntryBinding } from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RuntimeEntryJournal, readRuntimeEntryWitness, type RuntimeEntryDriverWrite } from '../src/runtime-entry-journal.ts'
import { RuntimeEntryFactory, type RuntimeEntryFactoryOptions } from '../src/runtime-entry.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { SessionWriteLease } from '../../../session/session-persistence-jsonl/src/lease.ts'

const fixture = JSON.parse(readFileSync(new URL('../../../host/control-protocol/tests/fixtures/project-operation-runtime-entry-v1.json', import.meta.url), 'utf8')) as { values: { binding: RuntimeEntryBinding } }
function binding() {
  const now = Date.now()
  return parseRuntimeEntryBinding({ ...fixture.values.binding, grantIssuedAt: now - 1000, grantExpiresAt: now + 60000 })
}
const sha = '1'.repeat(64), sha2 = '2'.repeat(64)
function storage() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-runtime-entry-'))
  const path = join(directory, 'entry.sqlite')
  const journal = new RuntimeEntryJournal(path)
  onTestFinished(() => { journal.close(); rmSync(directory, { recursive: true, force: true }) })
  return { journal, path }
}
function write(b = binding()): RuntimeEntryDriverWrite {
  return { binding: b, implementationDigest: sha, compositionDigest: sha2,
    queueOccurrenceId: '00000001-1111-4111-8111-000000000001', queueGeneration: '1',
    driverReservationId: '00000002-1111-4111-8111-000000000002', workerLifetimeId: '00000003-1111-4111-8111-000000000003',
    sessionInstanceGeneration: '1', sessionBirthReceiptDigest: sha,
    manifestInputs: { originalAuthorityDigest: sha, accountAuthorityDigest: sha2, sessionAuthorityDigest: sha,
      compositionAuthorityDigest: sha2, registryGeneration: '1' } }
}
async function harness(actualPersistence = false) {
  const ctx = new Context()
  onTestFinished(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const { journal, path } = storage()
  if (actualPersistence) await ctx.plugin(JsonlSessionPersistence, { root: join(dirname(path), 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('normal pipeline continued')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const b = binding(), agent = await ctx.agentLoop.create(SessionId(b.sessionId), { provider: 'mock', model: 'mock' })
  let authorityCurrent = true, sessionCurrent = true, compositionCurrent = true, materializeCount = 0, metadataCount = 0
  const options: RuntimeEntryFactoryOptions = { journal, workerLifetimeId: write(b).workerLifetimeId,
    implementationDigest: sha, compositionDigest: sha2, registryGeneration: '1', compositionAuthorityDigest: sha,
    async readOriginalMetadata(actual, commandId) {
      metadataCount++
      expect(actual).toBe(agent); expect(commandId).toBe(b.consumerCommandId)
      return { binding: b, projectId: brandString<import('@deepseek-ai/dsh-api-session-controller').ProjectOperationRuntimeEntryCandidate['projectId']>('original-admission-project'), taskRef: null, dispatchGranted: true, sourceKind: 'primary_human', originalAuthorityDigest: sha,
        accountAuthorityDigest: sha2, isCurrent: () => authorityCurrent }
    },
    async readLoadedSession(actual) {
      if (actualPersistence) return ctx.agentLoop.readOriginalInvocationEntrySession(actual)
      return { session: actual.session, birthReceiptDigest: sha, instanceGeneration: '1', sessionAuthorityDigest: sha2,
        logOffset: actual.session.seq, surfaceGeneration: actual.session.surface.contentGeneration, isCurrent: () => sessionCurrent }
    },
    isCurrentComposition: actual => actual === agent && compositionCurrent,
  }
  const factory = new RuntimeEntryFactory(options)
  onTestFinished(() =>{  factory.close() })
  const materialize = async () => {
    materializeCount++
    expect(journal.count()).toBe(1)
    expect(journal.byAttempt(b.consumerAttemptId)?.receipt.binding).toEqual(b)
    return createUserMessage({ content: [{ type: 'text', text: 'original feedback after durable entry' }], source: { kind: 'user' } })
  }
  return { ctx, agent, adapter, b, journal, path, factory, options, materialize,
    setAuthorityCurrent: (value: boolean) => { authorityCurrent = value },
    setSessionCurrent: (value: boolean) => { sessionCurrent = value },
    setCompositionCurrent: (value: boolean) => { compositionCurrent = value },
    counts: () => ({ materializeCount, metadataCount }) }
}

describe('private runtime entry journal', () => {
  it('commits a real durable body-free effect and immutable full manifest, then independently reads original bytes', () => {
    const { journal, path } = storage()
    const result = journal.commitOriginalInvocationEntry(write(), () => true)
    expect(result.receipt.entryEffectSeq).toBe('1')
    expect(result.receipt.journalCommitSequence).toBe('1')
    expect(result.manifest.sources).toHaveLength(22)
    expect(result.manifest.decisions).toHaveLength(12)
    expect(result.manifest.fieldDerivations).toHaveLength(23)
    expect(result.manifest.fieldDerivations.find(f => f.field === 'sourceSequence')?.sourceIds).toEqual(['implementation'])
    expect(journal.read(result.receipt.entryId)).toEqual(result)
    expect(journal.byAttempt(result.receipt.binding.consumerAttemptId)).toEqual(result)
    const sql = new DatabaseSync(path)
    try {
      expect(sql.prepare('PRAGMA application_id').get()?.application_id).toBe(0x44524531)
      expect(() => sql.prepare('UPDATE runtime_entries SET receipt_json=?').run('{}')).toThrow('immutable_runtime_entry')
      expect(() =>{  sql.exec('DELETE FROM runtime_entry_manifests') }).toThrow('immutable_runtime_entry')
      expect(() =>{  sql.exec("UPDATE runtime_entry_head SET sequence='9'") }).toThrow('invalid_runtime_entry_head')
      expect(() => journal.commitOriginalInvocationEntry(write(result.receipt.binding), () => true)).toThrow()
      expect(journal.count()).toBe(1)
    } finally { sql.close() }
  })

  it('fresh independent readback after writer close retains original IDs/time even after the original grant expires', () => {
    const { journal, path } = storage()
    const original = journal.commitOriginalInvocationEntry(write(), () => true)
    journal.close()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(original.receipt.binding.grantExpiresAt + 1)
    try { expect(readRuntimeEntryWitness(path, original.receipt.entryId)).toEqual(original) } finally { clock.mockRestore() }
    const reopened = new RuntimeEntryJournal(path)
    try { expect(reopened.byAttempt(original.receipt.binding.consumerAttemptId)).toEqual(original) } finally { reopened.close() }
  })

  it('final fence rollback leaves no event, manifest or head hole; retries never synthesize a historical entry', () => {
    const { journal } = storage()
    let calls = 0
    expect(() => journal.commitOriginalInvocationEntry(write(), () => ++calls === 1)).toThrow('fence_lost')
    expect(journal.count()).toBe(0)
    const receipt = journal.commitOriginalInvocationEntry(write(), () => true).receipt
    expect(receipt.entryEffectSeq).toBe('1')
    expect(journal.byAttempt(receipt.binding.consumerAttemptId)?.receipt).toEqual(receipt)
  })

  it('rejects expired grants, duplicate writers, wrong database purpose and unknown catalog without rewriting them', () => {
    const { journal, path } = storage()
    expect(() => new RuntimeEntryJournal(path)).toThrow()
    const b = binding()
    expect(() => journal.commitOriginalInvocationEntry(write(parseRuntimeEntryBinding({ ...b, grantIssuedAt: 1, grantExpiresAt: 2 })), () => true)).toThrow('fence_lost')
    journal.close()
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE unexpected (id TEXT) STRICT'); db.close()
    const before = readFileSync(path)
    expect(() => new RuntimeEntryJournal(path)).toThrow('catalog_changed')
    expect(readFileSync(path)).toEqual(before)
    const other = join(path, '..', 'wrong.sqlite'), wrong = new DatabaseSync(other)
    wrong.exec('PRAGMA application_id=123; CREATE TABLE unrelated(id TEXT) STRICT'); wrong.close(); chmodSync(other, 0o600)
    const original = readFileSync(other)
    expect(() => new RuntimeEntryJournal(other)).toThrow('wrong_purpose')
    expect(readFileSync(other)).toEqual(original)
  })
})

describe('actual original-feedback runtime writer', () => {
  it('uses actual startup ownership and drains real human live events through the original handle before the real driver/SQLite effect', async () => {
    const h = await harness(true)
    h.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'actual existing human source prefix' }], source: { kind: 'user' } }))
    // The original consumer owns a previously handled source prefix; clear this queued message normally.
    h.agent.inbox.clear()
    expect(h.agent.session.seq).toBeGreaterThan(0)
    const preparation = await h.factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)
    if (preparation.kind !== 'prepared') throw new Error('missing actual startup preparation')
    const result = await preparation.start(h.materialize)
    expect(result.kind).toBe('entered')
    expect(h.journal.count()).toBe(1); expect(h.counts().materializeCount).toBe(1)
    expect((await h.ctx.sessionPersistence.stat(h.agent.id))?.location).toBeDefined()
  })

  it('loss of the actual kernel lease at the final SQLite fence rolls back receipt/manifest/head and never reads feedback', async () => {
    const h = await harness(true)
    const preparation = await h.factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)
    if (preparation.kind !== 'prepared') throw new Error('missing actual startup preparation')
    const metadata = await h.ctx.sessionPersistence.stat(h.agent.id)
    if (metadata?.location?.kind !== 'jsonl') throw new Error('missing actual materialized session')
    const lock = join(dirname(metadata.location.path), 'session.lock')
    // oxlint-disable-next-line typescript/unbound-method -- Original implementation is called with its actual lease as explicit this.
    const original = SessionWriteLease.prototype.isCurrent
    let fences = 0
    const intercept = vi.spyOn(SessionWriteLease.prototype, 'isCurrent').mockImplementation(function (this: SessionWriteLease) {
      if (++fences === 4) { unlinkSync(lock); writeFileSync(lock, '', { mode: 0o600 }) }
      return original.call(this)
    })
    try {
      expect(await preparation.start(h.materialize)).toEqual({ kind: 'gap', reason: 'journal_failed' })
      expect(h.journal.count()).toBe(0); expect(h.counts().materializeCount).toBe(0); expect(h.adapter.requests).toHaveLength(0)
      const sql = new DatabaseSync(h.path)
      try { expect(sql.prepare('SELECT sequence FROM runtime_entry_head').get()?.sequence).toBe('0') } finally { sql.close() }
    } finally { intercept.mockRestore() }
  })

  it('private claim reaches real driver/FULL SQLite/readback before any body/status listener, then preserves ordinary execution', async () => {
    const h = await harness(), order: string[] = []
    h.ctx.on('agent/status', ({ status }) => { if (status === 'running') { expect(h.journal.count()).toBe(1); order.push('status-after-readback') } })
    h.ctx.on('agent/pre-inbox', () => { expect(h.journal.count()).toBe(1); order.push('pre-inbox') })
    const preparation = await h.factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)
    expect(preparation.kind).toBe('prepared')
    if (preparation.kind !== 'prepared') throw new Error('missing actual preparation')
    expect(h.journal.count()).toBe(0)
    const result = await preparation.start(async () => { order.push('body'); return h.materialize() })
    expect(result.kind).toBe('entered')
    expect(order).toEqual(['status-after-readback', 'body', 'pre-inbox'])
    expect(h.counts().materializeCount).toBe(1)
    expect(h.adapter.requests).toHaveLength(1)
    if (result.kind !== 'entered') throw new Error('missing actual receipt')
    expect(result.witness.receipt.binding.consumerAttemptId).toBe(h.b.consumerAttemptId)
    expect(result.witness.receipt.binding.originalExecutorRef).toEqual(h.b.originalExecutorRef)
    expect(JSON.stringify(result.witness)).not.toContain('original feedback after durable entry')
    await expect(preparation.start(h.materialize)).rejects.toThrow('claim_replayed')
    const historical = await h.factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)
    expect(historical.kind).toBe('historical')
    if (historical.kind === 'historical') expect(historical.witness).toEqual(result.witness)
    expect(h.counts().materializeCount).toBe(1)
  })

  it('unknown/restricted/import-derived metadata and body getter dependence never create a native receipt', async () => {
    const h = await harness()
    for (const sourceKind of ['unknown', 'restricted', 'live_reference'] as const) {
      const factory = new RuntimeEntryFactory({ ...h.options, readOriginalMetadata: async () => ({ binding: h.b, projectId: brandString<import('@deepseek-ai/dsh-api-session-controller').ProjectOperationRuntimeEntryCandidate['projectId']>('original-admission-project'), taskRef: null,
        dispatchGranted: true, sourceKind, originalAuthorityDigest: sha, accountAuthorityDigest: sha2, isCurrent: () => true }) })
      expect((await factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)).kind).toBe('unsupported')
    }
    let bodyReads = 0
    const source = Object.defineProperty({}, 'answer', { get() { bodyReads++; throw new Error('preentry_body_read') } }) as { answer: string }
    const unsafe = new RuntimeEntryFactory({ ...h.options, readOriginalMetadata: async () => {
      // Deliberately invalid provider: this dependency must fail before it can claim the fixed implementation.
      source.answer.includes('choose-original')
      return undefined
    } })
    await expect(unsafe.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)).rejects.toThrow('preentry_body_read')
    expect(bodyReads).toBe(1); expect(h.journal.count()).toBe(0); expect(h.counts().materializeCount).toBe(0)
    const safe = await h.factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)
    if (safe.kind !== 'prepared') throw new Error('missing safe preparation')
    expect((await safe.start(h.materialize)).kind).toBe('entered')
    expect(bodyReads).toBe(1)
  })

  it('actual prefix/queue changes, composition/owner/writer loss and cancellation invalidate the original private claim', async () => {
    for (const change of ['queue', 'empty-edit', 'maintenance', 'composition', 'owner', 'writer', 'cancel'] as const) {
      const h = await harness(), abort = new AbortController()
      const preparation = await h.factory.prepare(h.agent, h.b.consumerCommandId, abort.signal)
      if (preparation.kind !== 'prepared') throw new Error('missing preparation')
      if (change === 'queue') h.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'new private decision input' }], source: { kind: 'user' } }))
      else if (change === 'empty-edit') h.agent.inbox.clear()
      else if (change === 'maintenance') await h.agent.runMaintenance(async () => {})
      else if (change === 'composition') h.setCompositionCurrent(false)
      else if (change === 'owner') h.setAuthorityCurrent(false)
      else if (change === 'writer') h.setSessionCurrent(false)
      else abort.abort()
      expect((await preparation.start(h.materialize)).kind).toBe('gap')
      expect(h.journal.count()).toBe(0); expect(h.counts().materializeCount).toBe(0); expect(h.adapter.requests).toHaveLength(0)
    }
  })

  it('authority withdrawal in the first post-entry status listener preserves the real entry but reads no body', async () => {
    const h = await harness()
    h.ctx.on('agent/status', ({ status }) => { if (status === 'running') h.setAuthorityCurrent(false) })
    const preparation = await h.factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)
    if (preparation.kind !== 'prepared') throw new Error('missing preparation')
    expect((await preparation.start(h.materialize)).kind).toBe('entered')
    expect(h.journal.count()).toBe(1); expect(h.counts().materializeCount).toBe(0); expect(h.adapter.requests).toHaveLength(0)
  })

  it('concurrent preparation reserves an original attempt once without a second body or wake', async () => {
    const h = await harness(), signal = new AbortController().signal
    const preparations = await Promise.all([h.factory.prepare(h.agent, h.b.consumerCommandId, signal),
      h.factory.prepare(h.agent, h.b.consumerCommandId, signal)])
    const prepared = preparations.filter(p => p.kind === 'prepared')
    expect(prepared).toHaveLength(1)
    const one = prepared[0]
    if (one?.kind !== 'prepared') throw new Error('missing original preparation')
    expect((await one.start(h.materialize)).kind).toBe('entered')
    expect(h.journal.count()).toBe(1); expect(h.counts().materializeCount).toBe(1)
  })

  it('journal failure remains a visible gap while original business materializes once; no fake source success', async () => {
    const h = await harness()
    vi.spyOn(h.journal, 'commitOriginalInvocationEntry').mockImplementation(() => { throw new Error('real durable failure') })
    const preparation = await h.factory.prepare(h.agent, h.b.consumerCommandId, new AbortController().signal)
    if (preparation.kind !== 'prepared') throw new Error('missing preparation')
    let reads = 0
    const result = await preparation.start(async () => {
      reads++
      return createUserMessage({ content: [{ type: 'text', text: 'ordinary business despite source gap' }], source: { kind: 'user' } })
    })
    expect(result).toEqual({ kind: 'gap', reason: 'journal_failed' })
    expect(reads).toBe(1); expect(h.journal.count()).toBe(0); expect(h.adapter.requests).toHaveLength(1)
  })
})
