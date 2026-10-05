/** REQ-20260930-0004: private Profile preparation waits for the original coordinator grant. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  openCollaborationSourceJournal,
  openCollaborationAnalysisJournal,
  parseCollaborationClarificationInput, clarificationAnalysisMessage, collaborationJournalDigest,
} from '@deepseek-ai/dsh-api-session-controller'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopCollaborationAnalysis } from '../src/desktop-collaboration-analysis.ts'
const signal = () => new AbortController().signal
const binding = 'a'.repeat(64)
const input = (id = 'message') => ({
  workspace_id: '12345678-1234-4123-8123-123456789abc',
  session_id: 'session',
  source_message_id: id,
  source_revision: '1',
  original_message: '@Guide 请分析',
  active_mentions: [
    {
      mention_id: 'mention',
      source_span: { source_message_id: id, source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
      binding: {
        kind: 'resolved' as const,
        target: { project_id: '212', agent_id: 'guide' },
        capability_snapshot: 'b'.repeat(64),
      },
    },
  ],
})
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'req0004-profile-analysis-')),
    ctx = new Context(),
    lifetime = new AbortController()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }),
    sourceJournal = await openCollaborationSourceJournal(facility)
  const sources = new Set<string>()
  let calls = 0
  const capture: SessionController['captureCollaborationSource'] = async (value) => {
    const source = await sourceJournal.capture(
      {
        ...value,
        model_snapshot: {
          provider: 'fixture',
          model: 'selected',
          configuration_generation: '1',
          adapter_fingerprint: 'c'.repeat(64),
        },
      },
      signal(),
    )
    if (sources.has(value.source_message_id)) return { kind: 'recovered', snapshot: source }
    sources.add(value.source_message_id)
    return {
      kind: 'captured',
      snapshot: source,
      prepared: {} as never,
      analyzeClarification: async (clarification, persist, cancel) => {
        await persist({ prompt_version: '2', source: clarification.original_snapshot, clarification,
          request: { provider: 'fixture', model: 'selected', maxTokens: 8192, purpose: 'collaboration-analysis', tools: [],
            system: 'Analyze only original user content and its clarification.',
            messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: clarificationAnalysisMessage(clarification) }] })] } }, cancel)
        cancel.throwIfAborted(); calls++
        return { jsonText: '{"intent":"clarify"}' }
      },
      analyze: async (persist, cancel) => {
        await persist(
          {
            prompt_version: '1',
            source,
            request: {
              provider: 'fixture',
              model: 'selected',
              maxTokens: 8192,
              purpose: 'collaboration-analysis',
              tools: [],
              system: 'Analyze only original user content.',
              messages: [
                createMessage({
                  role: 'user',
                  source: { kind: 'user' },
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        source_message_id: source.source_message_id,
                        source_revision: source.source_revision,
                        original_message: source.original_message,
                        active_mentions: source.active_mentions,
                      }),
                    },
                  ],
                }),
              ],
            },
          },
          cancel,
        )
        cancel.throwIfAborted()
        calls++
        return { jsonText: '{"intent":"discuss"}' }
      },
    }
  }
  const owner = new DesktopCollaborationAnalysis(
    capture,
    () => openCollaborationAnalysisJournal(facility),
    lifetime.signal,
  )
  onTestFinished(async () => {
    await owner.close()
    await sourceJournal.close()
    await facility.closeAll()
    await backend.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { root, owner, lifetime, calls: () => calls,
    snapshot: (id: string) => sourceJournal.read({ workspace_id: input().workspace_id, session_id: input().session_id, source_message_id: id, source_revision: '1' })! }
}
const grant = (prepared: { attempt_request_id: string; input_manifest_digest: string; source_digest: string }) => ({
  ...prepared,
  plan_id: 'plan',
  expected_plan_revision: '1',
  attempt_id: 'attempt',
  attempt_fence: '1',
  lease_expires_at: new Date(Date.now() + 30000).toISOString(),
  dispatch_granted: true as const,
})
function receipt(value: Awaited<ReturnType<DesktopCollaborationAnalysis['prepare']>>) {
  if (value.kind !== 'prepared') throw Error('expected new preparation')
  return value
}
function permission(value: ReturnType<typeof receipt>) {
  const { attempt_request_id, input_manifest_digest, source_digest } = value
  return grant({ attempt_request_id, input_manifest_digest, source_digest })
}
it('prepare commits complete input without a model call; dispatch commits grant and runs once', async () => {
  const h = await harness(),
    p = receipt(await h.owner.prepare(input(), binding, signal()))
  expect(h.calls()).toBe(0)
  const file = await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')
  expect(file).toContain(input().original_message)
  expect(file).not.toContain('dispatch_granted')
  const result = await h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())
  expect(JSON.parse(result.jsonText)).toEqual({ intent: 'discuss' })
  expect(h.calls()).toBe(1)
  expect(await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')).toContain('dispatch_granted')
  expect(await readFile(join(h.root, 'collaboration_analysis_output_v2.json'), 'utf8')).toContain('json_text')
  await expect(h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())).rejects.toThrow()
  expect(h.calls()).toBe(1)
  expect((await h.owner.prepare(input(), binding, signal())).kind).toBe('recovered')
  expect(h.calls()).toBe(1)
})
it('wrong original binding cannot resume a prepared call, while its original owner can', async () => {
  const h = await harness(),
    p = receipt(await h.owner.prepare(input(), binding, signal()))
  await expect(h.owner.dispatch(p.attempt_request_id, 'd'.repeat(64), permission(p), signal())).rejects.toThrow()
  expect(h.calls()).toBe(0)
  await h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())
  expect(h.calls()).toBe(1)
})
it.each(['digest', 'source', 'expired', 'denied'] as const)(
  'invalid cloud grant never reaches a model (%s)',
  async (mode) => {
    const h = await harness(),
      p = receipt(await h.owner.prepare(input(), binding, signal())),
      g = permission(p)
    const bad = {
      ...g,
      ...(mode === 'digest'
        ? { input_manifest_digest: 'd'.repeat(64) }
        : mode === 'source'
          ? { source_digest: 'd'.repeat(64) }
          : mode === 'expired'
            ? { lease_expires_at: new Date(Date.now() - 1).toISOString() }
            : { dispatch_granted: false }),
    }
    await expect(h.owner.dispatch(p.attempt_request_id, binding, bad as typeof g, signal())).rejects.toThrow()
    expect(h.calls()).toBe(0)
  },
)
it('bounds pending calls and Profile close cancels unused preparations without rebuilding them', async () => {
  const h = await harness()
  await h.owner.prepare(input('one'), binding, signal())
  await h.owner.prepare(input('two'), binding, signal())
  await expect(h.owner.prepare(input('three'), binding, signal())).rejects.toThrow()
  expect(h.calls()).toBe(0)
  await h.owner.close()
  await expect(h.owner.prepare(input('four'), binding, signal())).rejects.toThrow()
  expect(h.calls()).toBe(0)
})
it('expires a preparation after 30 seconds and refuses its late grant', async () => {
  const h = await harness()
  vi.useFakeTimers()
  try {
    const p = receipt(await h.owner.prepare(input(), binding, signal()))
    await vi.advanceTimersByTimeAsync(30001)
    await expect(h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())).rejects.toThrow()
    expect(h.calls()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

function context(h: Awaited<ReturnType<typeof harness>>) {
  const original = h.snapshot('original'), reply = h.snapshot('reply')
  return parseCollaborationClarificationInput({ plan: { plan_id: 'plan', plan_revision: '3', input_version: '2' },
    clarification_request_id: 'reply-request', original_snapshot: original, reply_snapshot: reply,
    original_snapshot_digest: collaborationJournalDigest(original), reply_snapshot_digest: collaborationJournalDigest(reply),
    pending_items: [{ pending_item_id: 'pending', revision: '1', mention_ids: ['mention'], target: { project_id: '212', agent_id: 'guide' },
      reason: 'task_ambiguous', question: '检查哪些内容？', source_evidence_spans: [{ source_message_id: 'original', source_revision: '1', start: 0, end: original.original_message.length }] }],
    frozen_task_ids: ['accepted-task'], mention_order: ['mention'], prior_replies: [] })
}
const replyInput = () => ({ ...input('reply'), original_message: '只检查规则，不修改文件。', active_mentions: [] })
it('captures a reply without analysis, then persists a full clarification and consumes its matching new grant once', async () => {
  const h = await harness()
  await h.owner.prepare(input('original'), binding, signal())
  const reply = await h.owner.captureReply(replyInput(), binding, signal())
  expect(reply.kind).toBe('captured'); expect(h.calls()).toBe(0)
  expect(await h.owner.captureReply(replyInput(), binding, signal())).toMatchObject({ kind: 'recovered', descriptor: reply.descriptor })
  const p = receipt(await h.owner.prepareClarification(context(h), binding, signal()))
  expect(p.descriptor.source_message_id).toBe('original'); expect(h.calls()).toBe(0)
  await expect(h.owner.prepareClarification(context(h), binding, signal())).rejects.toThrow()
  expect(await h.owner.dispatch(p.attempt_request_id, binding, { ...permission(p), expected_plan_revision: '3' }, signal())).toEqual({ jsonText: '{"intent":"clarify"}' })
  expect(h.calls()).toBe(1)
  const saved = await readFile(join(h.root, 'collaboration_analysis_v2.json'), 'utf8')
  expect(saved).toContain('reply-request'); expect(saved).toContain('accepted-task')
  await expect(h.owner.dispatch(p.attempt_request_id, binding, { ...permission(p), expected_plan_revision: '3' }, signal())).rejects.toThrow()
  expect(h.calls()).toBe(1)
})
it('rejects reply ownership changes and competing preparations without constructing a second model attempt', async () => {
  const h = await harness()
  await h.owner.prepare(input('original'), binding, signal())
  await h.owner.captureReply(replyInput(), binding, signal())
  const c = context(h)
  await expect(h.owner.prepareClarification(c, 'd'.repeat(64), signal())).rejects.toThrow()
  const [one, two] = await Promise.allSettled([
    h.owner.prepareClarification(c, binding, signal()), h.owner.prepareClarification(c, binding, signal())])
  expect([one, two].filter(value => value.status === 'fulfilled')).toHaveLength(1)
  expect(h.calls()).toBe(0)
})
it('expires retained reply calls without leaking the preparation slot or restoring executable recovery', async () => {
  const h = await harness()
  vi.useFakeTimers()
  try {
    await h.owner.prepare(input('original'), binding, signal())
    await h.owner.captureReply(replyInput(), binding, signal())
    await vi.advanceTimersByTimeAsync(30001)
    await expect(h.owner.prepareClarification(context(h), binding, signal())).rejects.toThrow()
    expect((await h.owner.captureReply(replyInput(), binding, signal())).kind).toBe('recovered')
    expect((await h.owner.captureReply({ ...replyInput(), source_message_id: 'next-reply' }, binding, signal())).kind).toBe('captured')
    expect(h.calls()).toBe(0)
  } finally { vi.useRealTimers() }
})
