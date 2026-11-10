import { runtimeEntryTestCode } from '../../../api/session-controller/tests/runtime-entry-test-code.ts'
/** Actual driver-entry publication ordering; controlled origin/Cloud callbacks are component fixtures only. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseRuntimeEntryBinding } from '@deepseek-ai/dsh-host-control-protocol'
import { type RuntimeEntryFactoryOptions } from '../../../api/session-controller/src/runtime-entry.ts'
import { RuntimeEntryJournal } from '../../../api/session-controller/src/runtime-entry-journal.ts'
import type { ProjectOperationOriginToken, ProjectOperationOrigins, ProjectOperationRuntimeEntryCandidate, ProjectOperationRuntimeEntryPublication } from '@deepseek-ai/dsh-api-session-controller'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { DesktopRuntimeEntryOrigin } from '../src/desktop-runtime-entry-origin.ts'
const fixture = JSON.parse(readFileSync(new URL('../../../host/control-protocol/tests/fixtures/project-operation-runtime-entry-v1.json',
  import.meta.url), 'utf8')) as { values: { binding: unknown } }
const digest = '1'.repeat(64)
async function harness() {
  const ctx = new Context()
  onTestFinished(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('ordinary business continued')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const original = parseRuntimeEntryBinding(fixture.values.binding), now = Date.now()
  const binding = parseRuntimeEntryBinding({ ...original, grantIssuedAt: now - 1000, grantExpiresAt: now + 60000 })
  const agent = await ctx.agentLoop.create(SessionId(binding.sessionId), { provider: 'mock', model: 'mock' })
  const directory = mkdtempSync(join(tmpdir(), 'entry-publication-worker-')),
    journal = new RuntimeEntryJournal(join(directory, 'entry.sqlite'))
  onTestFinished(() => { journal.close(); rmSync(directory, { recursive: true, force: true }) })
  let current = true, metadataReads = 0
  const metadata = { binding, dispatchGranted: true, sourceKind: 'primary_human' as const, originalAuthorityDigest: digest,
    accountAuthorityDigest: digest, taskRef: brandString<NonNullable<ProjectOperationRuntimeEntryCandidate['taskRef']>>('original-task'),
    projectId: brandString<ProjectOperationRuntimeEntryCandidate['projectId']>('original-admission-project'), isCurrent: () => current }
  const code = runtimeEntryTestCode(directory)
  const options: RuntimeEntryFactoryOptions = { journal, workerLifetimeId: '00000001-1111-4111-8111-000000000001',
    assertCurrentCode: () => { code.assertCurrentCode() }, implementationDigest: digest, compositionDigest: digest, compositionAuthorityDigest: digest, registryGeneration: '1',
    readOriginalMetadata: async () => { metadataReads++; return metadata },
    readLoadedSession: async () => ({ session: agent.session, birthReceiptDigest: digest, instanceGeneration: '1',
      sessionAuthorityDigest: digest, logOffset: agent.session.seq, surfaceGeneration: agent.session.surface.contentGeneration,
      isCurrent: () => current }), isCurrentComposition: actual => current && actual === agent }
  let bindCount = 0, materializeCount = 0
  const provider: DesktopRuntimeEntryOrigin = new DesktopRuntimeEntryOrigin(ctx, { factoryOptions: options,
    isCurrent: actual => current && actual === agent,
    bindOriginalEntry: async (request): Promise<ProjectOperationRuntimeEntryPublication | null> => {
      bindCount++
      const witness = journal.byAttempt(binding.consumerAttemptId)
      expect(witness).toBeDefined()
      expect(request.originalCommandId).toBe(binding.consumerCommandId)
      const candidate = captured === undefined ? null : reader.readRuntimeEntry?.(captured)
      if (!candidate) return null
      return { attributionDigest: digest, observationDigest: digest, mappingDigest: digest, entryId: candidate.entryId,
        entryReceiptDigest: candidate.entryReceiptDigest, manifestDigest: candidate.manifestDigest, projectId: candidate.projectId,
        sourceEventId: brandString<ProjectOperationRuntimeEntryPublication['sourceEventId']>(request.sourceEventId), sourceRevision: request.sourceRevision, payloadDigest: digest }
    } })
  onTestFinished(() => { provider.close() })
  const reader: ProjectOperationOrigins = provider.readerWith({ read: () => Object.freeze([]) })
  ctx.provide('projectOperationOrigins', reader)
  let captured: ProjectOperationOriginToken | undefined
  const remember = (token: ProjectOperationOriginToken) => { captured = token }
  const materialize = async () => {
    materializeCount++
    expect(journal.count()).toBe(1)
    return createUserMessage({ content: [{ type: 'text', text: 'feedback body' }], source: { kind: 'user' } })
  }
  return { ctx, agent, provider, reader, binding, journal, materialize, remember, code,
    token: () => captured, revoke: () => { current = false }, counts: () => ({ bindCount, materializeCount }),
    metadataReads: () => metadataReads }
}
describe('runtime entry publication provider', () => {
  it('preserves the existing operation reader and rejects foreign tokens', async () => {
    const provider = new DesktopRuntimeEntryOrigin({} as never, {} as never)
    const reader: ProjectOperationOrigins = provider.readerWith({ read: () => Object.freeze([]) })
    expect(reader.read({} as never)).toEqual([])
    expect(reader.readRuntimeEntry?.({} as never)).toBeNull()
    await expect(reader.bindRuntimeEntry?.({} as never,
      { sourceEventId: 'foreign' as never, sourceRevision: '1' })).resolves.toBeNull()
    expect(() => provider.readerWith(reader)).toThrow('already_bound')
  })
  it('publishes from the actual driver commit/readback before materializing and invalidates retained tokens', async () => {
    const h = await harness()
    let publication: ProjectOperationRuntimeEntryPublication | null | undefined
    h.ctx.on('project-operation/runtime-entry', async (token) => {
      h.remember(token)
      expect(h.journal.count()).toBe(1)
      expect(h.counts().materializeCount).toBe(0)
      const candidate = h.reader.readRuntimeEntry?.(token)
      if (!candidate) throw Error('missing candidate')
      expect(candidate.taskRef).toBe('original-task')
      expect(candidate?.projectId).toBe('original-admission-project')
      expect(Object.isFrozen(candidate)).toBe(true)
      expect(Object.keys(candidate ?? {})).toHaveLength(11)
      publication = await h.reader.bindRuntimeEntry?.(token,
        { sourceEventId: brandString<ProjectOperationRuntimeEntryPublication['sourceEventId']>('dsh-runtime-entry:' + candidate.entryId), sourceRevision: '1' })
      return true
    })
    const prepared = await h.provider.prepare(h.agent, h.binding.consumerCommandId, new AbortController().signal)
    expect(prepared.kind).toBe('prepared')
    if (prepared.kind !== 'prepared') throw Error('missing actual driver')
    await expect(prepared.start(h.materialize)).resolves.toMatchObject({ kind: 'entered' })
    expect(publication).toBeTruthy()
    expect(h.metadataReads()).toBe(1)
    expect(h.counts()).toEqual({ bindCount: 1, materializeCount: 1 })
    const retained = h.token()
    if (!retained) throw Error('missing event token')
    expect(h.reader.readRuntimeEntry?.(retained)).toBeNull()
    await expect(h.reader.bindRuntimeEntry?.(retained,
      { sourceEventId: brandString<ProjectOperationRuntimeEntryPublication['sourceEventId']>('dsh-runtime-entry:any'), sourceRevision: '1' })).resolves.toBeNull()
    expect(h.journal.count()).toBe(1)
  })
  it('denies worker replacement across await and retains the committed entry without a second wake', async () => {
    const h = await harness()
    h.ctx.on('project-operation/runtime-entry', async (token) => {
      h.remember(token)
      await Promise.resolve(); h.revoke()
      expect(h.reader.readRuntimeEntry?.(token)).toBeNull()
      return false
    })
    const prepared = await h.provider.prepare(h.agent, h.binding.consumerCommandId, new AbortController().signal)
    if (prepared.kind !== 'prepared') throw Error('missing actual driver')
    await prepared.start(h.materialize)
    expect(h.journal.count()).toBe(1)
    expect(h.counts()).toEqual({ bindCount: 0, materializeCount: 0 })
  })
  it('expires the original grant across an awaited event without materialization or new publication', async () => {
    const h = await harness()
    h.ctx.on('project-operation/runtime-entry', async (token) => {
      h.remember(token)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(h.binding.grantExpiresAt)
      onTestFinished(() => { clock.mockRestore() })
      expect(h.reader.readRuntimeEntry?.(token)).toBeNull()
      return false
    })
    const prepared = await h.provider.prepare(h.agent, h.binding.consumerCommandId, new AbortController().signal)
    if (prepared.kind !== 'prepared') throw Error('missing actual driver')
    await prepared.start(h.materialize)
    expect(h.journal.count()).toBe(1)
    expect(h.counts()).toEqual({ bindCount: 0, materializeCount: 0 })
  })
  it('cancellation during the awaited event denies new publication and preserves historical entry', async () => {
    const h = await harness(), abort = new AbortController()
    h.ctx.on('project-operation/runtime-entry', async (token) => {
      h.remember(token); abort.abort()
      expect(h.reader.readRuntimeEntry?.(token)).toBeNull()
      return false
    })
    const prepared = await h.provider.prepare(h.agent, h.binding.consumerCommandId, abort.signal)
    if (prepared.kind !== 'prepared') throw Error('missing actual driver')
    await prepared.start(h.materialize)
    expect(h.journal.count()).toBe(1)
    expect(h.counts()).toEqual({ bindCount: 0, materializeCount: 0 })
  })
})

describe('original code after awaited publication', () => {
  it('keeps the durable entry but enters no body when code is changed and restored during the opaque event', async () => {
    const h = await harness(), { writeFileSync, utimesSync } = await import('node:fs')
    const bytes = readFileSync(h.code.path)
    h.ctx.on('project-operation/runtime-entry', async () => {
      expect(h.journal.count()).toBe(1)
      await Promise.resolve()
      writeFileSync(h.code.path, Buffer.alloc(bytes.length, 0x78))
      utimesSync(h.code.path, 1700000000, 1700000000)
      writeFileSync(h.code.path, bytes)
      utimesSync(h.code.path, 1700000000, 1700000000)
      return false
    })
    const prepared = await h.provider.prepare(h.agent, h.binding.consumerCommandId, new AbortController().signal)
    expect(prepared.kind).toBe('prepared'); if (prepared.kind !== 'prepared') throw Error('controlled preparation missing')
    const result = await prepared.start(h.materialize)
    expect(result.kind).toBe('entered'); expect(h.journal.count()).toBe(1)
    expect(h.counts().materializeCount).toBe(0); expect(() =>{  h.code.assertCurrentCode() }).toThrow()
    expect(h.code.checks()).toBeGreaterThanOrEqual(3)
  })
})
