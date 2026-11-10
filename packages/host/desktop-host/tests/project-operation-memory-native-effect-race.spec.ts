import { runtimeEntryTestCode } from '../../../api/session-controller/tests/runtime-entry-test-code.ts'
/** Actual driver/JSONL and two real allocators; controlled origin metadata tests ordering only, not export permission. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  parseRuntimeEntryBinding,
  runtimeEntryReceiptDigest,
  type RuntimeEntryBinding,
} from '@deepseek-ai/dsh-host-control-protocol'
import {
  RuntimeEntryJournal,
  readRuntimeEntryFrontier,
  readRuntimeEntryEffect,
} from '../../../api/session-controller/src/runtime-entry-journal.ts'
import { RuntimeEntryFactory } from '../../../api/session-controller/src/runtime-entry.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'

const selectedSource = process.env.DSH_TEST_DSBOT_NATIVE_SOURCE
const seed = JSON.parse(
  readFileSync(
    new URL('../../control-protocol/tests/fixtures/project-operation-runtime-entry-v1.json', import.meta.url),
    'utf8',
  ),
) as { values: { binding: RuntimeEntryBinding } }
type Candidate = { entryId: string; entryReceiptDigest: string; manifestDigest: string }
type MixedRecord = { candidate: Candidate; mapping: { sourceSequence: string } }
type MixedJournal = {
  journalEpoch: string
  highWaterMark(): string
  appendRuntimeEntryCandidate(value: object): MixedRecord
  close(): void
}
type MixedModule = { openProjectOperationJournal(path: string): Promise<MixedJournal> }
type EffectModule = {
  nativeEffectPosition(
    record: { nativeEntry: MixedRecord },
    cut: object,
    reader: object,
    token: object,
    guard: () => void,
  ): Promise<'old' | 'new' | 'unsupported'>
}
function exportsWith(value: unknown, property: string): unknown {
  if (!value || typeof value !== 'object' || typeof Reflect.get(value, property) !== 'function')
    throw Error('missing selected actual source export')
  return value
}
it.skipIf(!selectedSource || process.platform === 'win32')(
  'real effects before and after H→E retain ordering when the first mixed append is late',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'req0006-native-effect-race-')),
      ctx = new Context(),
      path = join(root, 'runtime-entry.sqlite')
    const owned: { factory?: RuntimeEntryFactory; runtime?: RuntimeEntryJournal; mixed?: MixedJournal } = {}
    onTestFinished(async () => {
      owned.factory?.close()
      try {
        await ctx.fiber.dispose()
      } finally {
        try {
          owned.runtime?.close()
        } finally {
          owned.mixed?.close()
          rmSync(root, { recursive: true, force: true })
        }
      }
    })
    const runtime = new RuntimeEntryJournal(path)
    owned.runtime = runtime
    const mixedModule = exportsWith(
      await import(pathToFileURL(join(selectedSource!, 'src/host/project-operation-journal.js')).href),
      'openProjectOperationJournal',
    ) as MixedModule
    const effectModule = exportsWith(
      await import(pathToFileURL(join(selectedSource!, 'src/host/project-operation-native-effect.js')).href),
      'nativeEffectPosition',
    ) as EffectModule
    const mixed = await mixedModule.openProjectOperationJournal(join(root, 'mixed.sqlite'))
    owned.mixed = mixed
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('ordinary response one'), textResponse('ordinary response two')])
    ctx.llm.registerAdapter(['mock'], adapter)
    let original = parseRuntimeEntryBinding({
      ...seed.values.binding,
      grantIssuedAt: Date.now() - 1000,
      grantExpiresAt: Date.now() + 60000,
    })
    const agent = await ctx.agentLoop.create(SessionId(original.sessionId), { provider: 'mock', model: 'mock' })
    const code = runtimeEntryTestCode(root)
    const factory = new RuntimeEntryFactory({
      assertCurrentCode: () => { code.assertCurrentCode() },
      journal: runtime,
      workerLifetimeId: randomUUID(),
      implementationDigest: '1'.repeat(64),
      compositionDigest: '2'.repeat(64),
      registryGeneration: '1',
      compositionAuthorityDigest: '3'.repeat(64),
      readOriginalMetadata: async (actual, commandId) => {
        expect(actual).toBe(agent)
        expect(commandId).toBe(original.consumerCommandId)
        return {
          binding: original,
          projectId: brandString<import('@deepseek-ai/dsh-api-session-controller').ProjectOperationRuntimeEntryCandidate['projectId']>('controlled-origin-project'),
          taskRef: null,
          dispatchGranted: true,
          sourceKind: 'primary_human',
          originalAuthorityDigest: '4'.repeat(64),
          accountAuthorityDigest: '5'.repeat(64),
          isCurrent: () => ctx.agents.get(agent.id) === agent,
        }
      },
      readLoadedSession: actual => ctx.agentLoop.readOriginalInvocationEntrySession(actual),
      isCurrentComposition: actual => actual === agent,
    })
    owned.factory = factory
    const run = async () => {
      const preparation = await factory.prepare(agent, original.consumerCommandId, new AbortController().signal)
      if (preparation.kind !== 'prepared') throw Error('actual driver preparation unavailable')
      const entered = await preparation.start(async () =>
        createUserMessage({
          content: [{ type: 'text', text: 'controlled original feedback after actual entry' }],
          source: { kind: 'user' },
        }),
      )
      if (entered.kind !== 'entered') throw Error('actual driver did not enter')
      return entered.witness.receipt
    }
    const first = await run(),
      h = mixed.highWaterMark(),
      e = readRuntimeEntryFrontier(path)
    expect(h).toBe('0')
    expect(e.effectHead).toBe('1')
    const append = (receipt: typeof first) =>
      mixed.appendRuntimeEntryCandidate({
        profileId: receipt.binding.hostProfileId,
        botRootId: receipt.binding.botId,
        sessionId: receipt.binding.sessionId,
        ownerUserId: receipt.binding.ownerUserId,
        projectId: 'controlled-origin-project',
        taskRef: null,
        invocationRef: receipt.binding.invocationId,
        entryId: receipt.entryId,
        entryEffectAt: receipt.entryEffectAt,
        entryReceiptDigest: runtimeEntryReceiptDigest(receipt),
        manifestDigest: receipt.manifestDigest,
      })
    const late = append(first)
    const reader = { readRuntimeEntryEffect: (_token: object, ref: Candidate) => readRuntimeEntryEffect(path, ref) }
    expect(await effectModule.nativeEffectPosition({ nativeEntry: late }, e, reader, {}, () => {})).toBe('old')
    original = parseRuntimeEntryBinding({
      ...original,
      rootTaskId: randomUUID(),
      consumerCommandId: randomUUID(),
      consumerAttemptId: randomUUID(),
      consumerStepGrantId: randomUUID(),
      invocationId: 'controlled-independent-invocation-two',
      originalExecutorRef: { ...original.originalExecutorRef, invocationId:'controlled-independent-invocation-two' },
    })
    const second = await run(),
      next = append(second)
    expect(second.entryEffectSeq).toBe('2')
    expect(BigInt(next.mapping.sourceSequence)).toBeGreaterThan(BigInt(h))
    expect(await effectModule.nativeEffectPosition({ nativeEntry: next }, e, reader, {}, () => {})).toBe('new')
    expect(adapter.requests).toHaveLength(2)
    // The candidates remain unpublished; these causal coordinates grant no SourceProof or material Right.
  },
)
