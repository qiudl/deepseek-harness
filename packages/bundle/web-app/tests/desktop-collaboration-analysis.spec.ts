/** REQ-20260930-0004: private Profile preparation waits for the original coordinator grant. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  openCollaborationRootJournal,
  openCollaborationSourceJournal,
  openCollaborationAnalysisJournal,
  parseCollaborationClarificationInput, clarificationAnalysisMessage, collaborationJournalDigest,
} from '@deepseek-ai/dsh-api-session-controller'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { CollaborationAnalysisManifest } from '../../../api/session-controller/src/collaboration-analysis.ts'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopCollaborationAnalysis, handleDesktopCollaborationAnalysisRequest } from '../src/desktop-collaboration-analysis.ts'
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
async function harness(journalOpenFailure?: Error, beforeOutput = async (_signal: AbortSignal) => {}) {
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
        await beforeOutput(cancel)
        cancel.throwIfAborted()
        return { jsonText: '{"intent":"discuss"}' }
      },
    }
  }
  const captureCall = vi.fn(capture)
  const open = vi.fn(() => openCollaborationAnalysisJournal(facility))
  if (journalOpenFailure) open.mockRejectedValueOnce(journalOpenFailure)
  const readSource = vi.fn<SessionController['readCollaborationSourceSnapshot']>(async (target, active) => {
    active.throwIfAborted()
    const snapshot = sourceJournal.read(target)
    if (!snapshot) throw Error('membership')
    return snapshot
  })
  const owner = new DesktopCollaborationAnalysis(
    captureCall,
    open,
    lifetime.signal,
    undefined, undefined, undefined, undefined, undefined, undefined, readSource,
  )
  onTestFinished(async () => {
    if (journalOpenFailure) await expect(owner.close()).rejects.toBe(journalOpenFailure)
    else await owner.close()
    await sourceJournal.close()
    await facility.closeAll()
    await backend.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { root, owner, lifetime, facility, readSource, capture: captureCall, open, calls: () => calls,
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
it('persists an analysis failure before closing without a second dispatch or leaking the error', async () => {
  const secret = 'provider-private-details'
  const h = await harness(undefined, async () => { throw Error(secret) })
  const p = receipt(await h.owner.prepare(input(), binding, signal()))
  await expect(h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())).rejects.toThrow(secret)
  await h.owner.close()
  const reopened = await openCollaborationAnalysisJournal(h.facility)
  const rows = [...reopened.failures()]
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ reason: 'unclassified', input_manifest_digest: p.input_manifest_digest })
  expect(JSON.stringify(rows)).not.toContain(secret)
  expect(h.calls()).toBe(1)
  await reopened.close()
})
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

async function httpFixture(h: Awaited<ReturnType<typeof harness>>) {
  const token = 'C'.repeat(43)
  const response = Promise.withResolvers<ServerResponse>()
  const server = createServer((req, res) => {
    response.resolve(res)
    void handleDesktopCollaborationAnalysisRequest(req, res, token, h.owner)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (value: unknown, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization }, body: JSON.stringify(value),
  })
  return { url, post, token, response: response.promise }
}

it('private analysis HTTP rejects browser authority and malformed commands without analyzing', async () => {
  const h = await harness(), f = await httpFixture(h)
  const command = { action: 'prepare', binding_key: binding, input: input() }
  for (const authorization of ['', 'Bearer short', `Bearer ${'A'.repeat(43)}`]) {
    expect((await f.post(command, authorization)).status).toBe(403)
  }
  expect((await fetch(f.url, { headers: { cookie: 'dsh-auth=browser' } })).status).toBe(403)
  expect((await fetch(f.url, { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(403)
  for (const body of [null, [], 'prepare', {}, { ...command, action: 'unknown' },
    { ...command, binding_key: null }, { ...command, binding_key: 'not-a-digest' },
    { action: 'prepare', binding_key: binding, extra: true },
    { ...command, api_key: 'private' },
    { action: 'dispatch', binding_key: binding, attempt_request_id: 12, grant: {} },
    { action: 'dispatch', binding_key: binding, attempt_request_id: 'not-an-attempt', grant: {} },
    { ...command, padding: 'x'.repeat(1024 * 1024) }]) {
    const response = await f.post(body)
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'invalid_input' })
  }
  expect(h.calls()).toBe(0)
})

it('private analysis HTTP prepares and dispatches once without cancelling acknowledged ownership', async () => {
  const h = await harness(), f = await httpFixture(h)
  const response = await f.post({ action: 'prepare', binding_key: binding, input: input() })
  expect(response.status).toBe(200)
  const p = receipt((await response.json() as { value: Awaited<ReturnType<DesktopCollaborationAnalysis['prepare']>> }).value)
  expect(h.calls()).toBe(0)
  const dispatch = { action: 'dispatch', binding_key: binding, attempt_request_id: p.attempt_request_id, grant: permission(p) }
  const result = await f.post(dispatch)
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ value: { jsonText: '{"intent":"discuss"}' } })
  expect((await f.post(dispatch)).status).toBe(422)
  expect(h.calls()).toBe(1)
})

it('private analysis HTTP retains a same-chat clarification and sanitizes unavailable ownership', async () => {
  const h = await harness(), f = await httpFixture(h)
  expect((await f.post({ action: 'prepare', binding_key: binding, input: input('original') })).status).toBe(200)
  expect((await f.post({ action: 'capture_reply', binding_key: binding, input: input('new-mention') })).status).toBe(422)
  expect((await f.post({ action: 'capture_reply', binding_key: binding, input: replyInput() })).status).toBe(200)
  const prepared = await f.post({ action: 'prepare_clarification', binding_key: binding, input: context(h) })
  expect(prepared.status).toBe(200)
  const p = receipt((await prepared.json() as { value: Awaited<ReturnType<DesktopCollaborationAnalysis['prepare']>> }).value)
  expect(h.calls()).toBe(0)
  expect((await f.post({ action: 'dispatch', binding_key: binding, attempt_request_id: p.attempt_request_id,
    grant: { ...permission(p), expected_plan_revision: '3' } })).status).toBe(200)
  expect(h.calls()).toBe(1)
  await h.owner.close()
  const closed = await f.post({ action: 'prepare', binding_key: binding, input: input('closed') })
  expect(closed.status).toBe(422)
  expect(await closed.json()).toEqual({ error: 'unavailable' })
})

it('releases preparation capacity after Source capture fails without starting a model', async () => {
  const h = await harness()
  h.capture.mockRejectedValueOnce(Error('source storage failed'))
  await expect(h.owner.prepare(input('failed'), binding, signal())).rejects.toThrow('source storage failed')
  expect((await h.owner.prepare(input('next'), binding, signal())).kind).toBe('prepared')
  expect(h.calls()).toBe(0)
})

it('refuses a captured result that omitted the durable analysis input', async () => {
  const h = await harness()
  const captured = await h.capture(input(), signal())
  if (captured.kind !== 'captured') throw Error('expected first capture')
  h.capture.mockResolvedValueOnce({ ...captured, analyze: async () => ({ jsonText: '{}' }) })
  await expect(h.owner.prepare(input(), binding, signal())).rejects.toThrow()
  expect(h.calls()).toBe(0)
})

it('caller cancellation before the dispatch write finishes never reaches the model', async () => {
  const h = await harness()
  const p = receipt(await h.owner.prepare(input(), binding, signal()))
  const caller = new AbortController()
  const work = h.owner.dispatch(p.attempt_request_id, binding, permission(p), caller.signal)
  const rejected = expect(work).rejects.toThrow('collaboration_analysis_cancelled')
  caller.abort('caller lost authority')
  await rejected
  expect(h.calls()).toBe(0)
})

it('failed reply capture frees its slot and closed ownership refuses new replies', async () => {
  const h = await harness()
  h.capture.mockRejectedValueOnce(Error('reply storage failed'))
  await expect(h.owner.captureReply(replyInput(), binding, signal())).rejects.toThrow('reply storage failed')
  expect((await h.owner.captureReply(replyInput(), binding, signal())).kind).toBe('captured')
  await h.owner.close()
  await expect(h.owner.captureReply(replyInput(), binding, signal())).rejects.toThrow('collaboration_analysis_closed')
  expect(h.calls()).toBe(0)
})

it('duplicate reply capture refuses an executable capability instead of treating it as recovery', async () => {
  const h = await harness()
  const retained = Promise.withResolvers<Awaited<ReturnType<SessionController['captureCollaborationSource']>>>()
  const capture = h.capture.getMockImplementation()!
  h.capture.mockImplementationOnce(async (input, signal) => {
    const result = await capture(input, signal)
    retained.resolve(result)
    return result
  })
  await h.owner.captureReply(replyInput(), binding, signal())
  h.capture.mockResolvedValueOnce(await retained.promise)
  await expect(h.owner.captureReply(replyInput(), binding, signal()))
    .rejects.toThrow('collaboration_analysis_preparation_unavailable')
  expect((await h.owner.captureReply(replyInput(), binding, signal())).kind).toBe('recovered')
  expect(h.calls()).toBe(0)
})

it('failed clarification journal opening consumes no model call and releases the retained slot', async () => {
  const h = await harness(Error('analysis journal failed'))
  await h.capture(input('original'), signal())
  await h.owner.captureReply(replyInput(), binding, signal())
  await expect(h.owner.prepareClarification(context(h), binding, signal())).rejects.toThrow('analysis journal failed')
  expect((await h.owner.captureReply({ ...replyInput(), source_message_id: 'next-reply' }, binding, signal())).kind)
    .toBe('captured')
  expect(h.calls()).toBe(0)
})

it.each(['prepare', 'reply'] as const)('cancels an in-flight %s capture and releases its preparation slot', async (operation) => {
  const h = await harness()
  const entered = Promise.withResolvers<AbortSignal>()
  h.capture.mockImplementationOnce(async (_input, owned) => {
    entered.resolve(owned)
    return await new Promise<Awaited<ReturnType<SessionController['captureCollaborationSource']>>>((_resolve, reject) => {
      owned.addEventListener('abort', () => {
        reject(owned.reason instanceof Error ? owned.reason : Error('capture cancelled'))
      }, { once: true })
    })
  })
  const caller = new AbortController()
  const reason = Error('caller cancelled capture')
  const work = operation === 'prepare'
    ? h.owner.prepare(input(), binding, caller.signal)
    : h.owner.captureReply(replyInput(), binding, caller.signal)
  const rejected = expect(work).rejects.toBe(reason)
  const owned = await entered.promise
  caller.abort(reason)
  await rejected
  expect(owned.aborted).toBe(true)
  expect((await h.owner.captureReply(replyInput(), binding, signal())).kind).toBe('captured')
  expect(h.calls()).toBe(0)
})

it('cancels clarification while its journal opens and releases the consumed reply slot', async () => {
  const h = await harness()
  await h.capture(input('original'), signal())
  await h.owner.captureReply(replyInput(), binding, signal())
  const journal = await h.open()
  const entered = Promise.withResolvers<undefined>()
  const opening = Promise.withResolvers<typeof journal>()
  h.open.mockImplementationOnce(() => { entered.resolve(undefined); return opening.promise })
  const caller = new AbortController()
  const reason = Error('caller cancelled clarification')
  const work = h.owner.prepareClarification(context(h), binding, caller.signal)
  const rejected = expect(work).rejects.toBe(reason)
  await entered.promise
  caller.abort(reason)
  await rejected
  opening.resolve(journal)
  expect((await h.owner.captureReply({ ...replyInput(), source_message_id: 'after-cancel' }, binding, signal())).kind)
    .toBe('captured')
  expect(h.calls()).toBe(0)
})

it('private analysis HTTP disconnect cancels capture without starting an analysis', async () => {
  const h = await harness(), f = await httpFixture(h)
  const captured = await h.capture(input(), signal())
  const entered = Promise.withResolvers<AbortSignal>()
  const cancelled = Promise.withResolvers<undefined>()
  h.capture.mockImplementationOnce(async (_input, owned) => {
    entered.resolve(owned)
    await new Promise<void>((resolve) => {
      owned.addEventListener('abort', () => { cancelled.resolve(undefined); resolve() }, { once: true })
    })
    return captured
  })
  const caller = new AbortController()
  const request = fetch(f.url, { method: 'POST', headers: { authorization: `Bearer ${f.token}` },
    body: JSON.stringify({ action: 'prepare', binding_key: binding, input: input() }), signal: caller.signal })
  const rejected = expect(request).rejects.toThrow()
  const owned = await entered.promise
  caller.abort()
  await rejected
  await cancelled.promise
  expect(owned.aborted).toBe(true)
  expect(h.calls()).toBe(0)
})

it('a response completed by the transport cannot receive a second acknowledgement or run a model', async () => {
  const h = await harness(), f = await httpFixture(h)
  const captured = await h.capture(input(), signal())
  const entered = Promise.withResolvers<undefined>()
  const capture = Promise.withResolvers<typeof captured>()
  const finished = Promise.withResolvers<undefined>()
  const prepare = h.owner.prepare.bind(h.owner)
  vi.spyOn(h.owner, 'prepare').mockImplementation(async (...args) => {
    try { return await prepare(...args) } finally { finished.resolve(undefined) }
  })
  h.capture.mockImplementationOnce(() => { entered.resolve(undefined); return capture.promise })
  const request = f.post({ action: 'prepare', binding_key: binding, input: input() })
  await entered.promise
  const response = await f.response
  response.writeHead(504, { 'cache-control': 'no-store' }).end()
  expect((await request).status).toBe(504)
  capture.resolve(captured)
  await finished.promise
  expect(response.writableEnded).toBe(true)
  expect(h.calls()).toBe(0)
})

it('private analysis HTTP deadline cancels its request even when capture ignores cancellation', async () => {
  const h = await harness(), f = await httpFixture(h)
  const captured = await h.capture(input(), signal())
  const entered = Promise.withResolvers<AbortSignal>()
  const capture = Promise.withResolvers<typeof captured>()
  const finished = Promise.withResolvers<undefined>()
  const prepare = h.owner.prepare.bind(h.owner)
  vi.spyOn(h.owner, 'prepare').mockImplementation(async (...args) => {
    entered.resolve(args[2])
    try { return await prepare(...args) } finally { finished.resolve(undefined) }
  })
  h.capture.mockImplementationOnce(() => capture.promise)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const request = f.post({ action: 'prepare', binding_key: binding, input: input() })
    const outcome = request.then(response => response.status, () => 0)
    const requestSignal = await entered.promise
    await vi.advanceTimersByTimeAsync(35_001)
    expect(requestSignal.aborted).toBe(true)
    capture.resolve(captured)
    await finished.promise
    expect([0, 422]).toContain(await outcome)
    expect(h.calls()).toBe(0)
  } finally { capture.resolve(captured); vi.useRealTimers() }
})

it('reopens saved output from disk with original grant, without another preparation or model call', async () => {
  const h = await harness(), prepared = receipt(await h.owner.prepare(input(), binding, signal()))
  const source = (await h.capture(input(), signal())).snapshot
  const roots = await openCollaborationRootJournal(h.facility)
  onTestFinished(() => roots.close())
  const pending = await roots.capture({ namespace_id:'n2_'+'a'.repeat(64),source,objective_ref:'o',task_grant_ref:'g',continuation_policy:'follow_authorized_plan' },signal())
  const admitted = await roots.accept(pending.command_id,{ root_task_id:pending.root_task_id,root_trace_id:pending.root_trace_id,admission_id:pending.command_id,task_revision:1,state_version:1,state:'active' },signal())
  const originalGrant = permission(prepared)
  const output = await h.owner.dispatch(prepared.attempt_request_id,binding,originalGrant,signal())
  await h.owner.close()
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(h.root)
  ctx.storage.backend.register('json',backend)
  const facility = new DomainFacility(ctx,{ backend:'json' })
  let reads=0,changed=false
  const reader: SessionController['readCollaborationRoot'] = async()=>{
    reads++
    return changed&&reads%2===0?pending:admitted
  }
  const recovered = new DesktopCollaborationAnalysis(async()=>{throw Error('recovery must not capture')},()=>openCollaborationAnalysisJournal(facility),signal(),undefined,reader)
  try {
    const target = { namespace_id:admitted.namespace_id,command_id:admitted.command_id,
      workspace_id:source.workspace_id,session_id:source.session_id,
      source_message_id:source.source_message_id,source_revision:source.source_revision }
    const result = await recovered.readRootOutput(target,signal())
    expect(result.state).toBe('saved')
    if(result.state!=='saved')throw Error('missing saved output')
    expect(result.dispatch).toEqual(originalGrant)
    expect(result.root.root_trace_id).toBe(admitted.root_trace_id)
    expect(Buffer.from(result.json_base64url,'base64url').toString('utf8')).toBe(output.jsonText)
    expect(reads).toBe(2)
    expect(h.calls()).toBe(1)
    changed=true
    await expect(recovered.readRootOutput(target,signal())).rejects.toThrow()
    const abort=new AbortController();abort.abort()
    await expect(recovered.readRootOutput(target,abort.signal)).rejects.toThrow()
    await recovered.close()
    await expect(recovered.readRootOutput(target,signal())).rejects.toThrow()
  } finally {
    await recovered.close();await facility.closeAll();await backend.close();await ctx.fiber.dispose()
  }
})

it.each(['live','handoff','pending','binding','expired','closed','reopened','membership','external_dispatch'] as const)('live root resume retains original attempt and deadline: %s',async(mode)=>{
  const h=await harness(), roots=await openCollaborationRootJournal(h.facility)
  let entry:Awaited<ReturnType<typeof roots.capture>>|undefined, member=true
  const reader:SessionController['readCollaborationRoot']=async()=>{if(!entry||!member)throw Error('membership');return entry}
  const captureRoot:SessionController['captureCollaborationRoot']=async(value,active)=>{
    const capture=await h.capture(value.source,active)
    entry=await roots.capture({ ...value,source:capture.snapshot,objective_ref:'o',task_grant_ref:'g' },active)
    return { ...capture,submission:entry }
  }
  let owner=new DesktopCollaborationAnalysis(
    h.capture,h.open,h.lifetime.signal,captureRoot,reader,
  )
  onTestFinished(async()=>{await owner.close();await roots.close()})
  vi.useFakeTimers()
  try {
    const request={ source:input(),namespace_id:'n2_'+'a'.repeat(64),continuation_policy:'follow_authorized_plan' }
    const p=receipt(await owner.prepareRoot(request,binding,signal(),binding))
    if(!entry)throw Error('missing root')
    if(mode!=='pending')entry=await roots.accept(entry.command_id,{ root_task_id:entry.root_task_id,root_trace_id:entry.root_trace_id,
      admission_id:entry.command_id,task_revision:1,state_version:1,state:'active' },signal())
    if(mode==='expired')await vi.advanceTimersByTimeAsync(30001)
    if(mode==='closed'||mode==='reopened')await owner.close()
    if(mode==='reopened')owner=new DesktopCollaborationAnalysis(async()=>{throw Error('must not recapture')},()=>openCollaborationAnalysisJournal(h.facility),signal(),undefined,reader)
    if(mode==='membership')member=false
    if(mode==='external_dispatch') {
      const journal = await h.open.mock.results.at(-1)!.value as Awaited<ReturnType<typeof openCollaborationAnalysisJournal>>
      await journal.dispatch([...journal.records()][0]!, permission(p), signal())
    }
    const resume=owner.resumeRoot(request,mode==='handoff'?'c'.repeat(64):binding,signal(),mode==='binding'?'b'.repeat(64):binding)
    if(mode==='live'||mode==='handoff'){
      expect(await resume).toEqual(p)
      expect(h.calls()).toBe(0)
      if(mode==='handoff')await expect(owner.dispatch(p.attempt_request_id,binding,permission(p),signal())).rejects.toThrow()
      await owner.dispatch(p.attempt_request_id,mode==='handoff'?'c'.repeat(64):binding,permission(p),signal())
      await expect(owner.resumeRoot(request,binding,signal(),binding)).rejects.toThrow()
      expect(h.calls()).toBe(1)
    }else{await expect(resume).rejects.toThrow();expect(h.calls()).toBe(0)}
  } finally {vi.useRealTimers()}
})

async function admittedRootFixture() {
  const h = await harness(), roots = await openCollaborationRootJournal(h.facility)
  onTestFinished(() => roots.close())
  const capture = await h.capture(input(), signal())
  const pending = await roots.capture({ namespace_id: 'n2_' + 'a'.repeat(64), source: capture.snapshot,
    objective_ref: 'o', task_grant_ref: 'g', continuation_policy: 'follow_authorized_plan' }, signal())
  const root = await roots.accept(pending.command_id, { root_task_id: pending.root_task_id, root_trace_id: pending.root_trace_id,
    admission_id: pending.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal())
  const reader = vi.fn<SessionController['readCollaborationRoot']>(async () => root)
  const owner = new DesktopCollaborationAnalysis(h.capture, () => openCollaborationAnalysisJournal(h.facility),
    h.lifetime.signal, undefined, reader)
  onTestFinished(() => owner.close())
  const target = { namespace_id: root.namespace_id, command_id: root.command_id, workspace_id: root.source.workspace_id,
    session_id: root.source.session_id, source_message_id: root.source.source_message_id, source_revision: root.source.source_revision }
  return { h, root, reader, owner, target, input: { namespace_id: root.namespace_id, source: input(), continuation_policy: 'follow_authorized_plan' } }
}
it('reports missing original output without starting a model, and rejects closure during its final read', async () => {
  const f = await admittedRootFixture()
  expect(await f.owner.readRootOutput(f.target, signal())).toMatchObject({ state: 'missing' })
  f.reader.mockResolvedValueOnce(f.root).mockImplementationOnce(async () => { await f.owner.close(); return f.root })
  await expect(f.owner.readRootOutput(f.target, signal())).rejects.toThrow('analysis_closed')
  expect(f.h.calls()).toBe(0)
})
it('rejects root recovery with unavailable source coordinates or no membership reader', async () => {
  const f = await admittedRootFixture()
  for (const source of [null, [], 'source'])
    await expect(f.owner.recoverRoot({ ...f.input, source }, signal())).rejects.toThrow('root_unavailable')
  await expect(f.h.owner.recoverRoot(f.input, signal())).rejects.toThrow('root_unavailable')
  expect(f.reader).not.toHaveBeenCalled()
})
it('discards a resumed preparation if its root changes across membership reads', async () => {
  const f = await admittedRootFixture()
  f.reader.mockResolvedValueOnce(f.root).mockResolvedValueOnce({ ...f.root, root_trace_id: 'f'.repeat(32) as typeof f.root.root_trace_id })
  await expect(f.owner.resumeRoot(f.input, binding, signal(), binding)).rejects.toThrow('preparation_unavailable')
})
it('refuses ambiguous saved output instead of choosing between separately consumed inputs', async () => {
  const f = await admittedRootFixture(), prepared = receipt(await f.h.owner.prepare({ ...input(), source_message_id: 'second',
    active_mentions: input().active_mentions.map(m => ({ ...m, source_span: { ...m.source_span, source_message_id: 'second' } })) }, binding, signal()))
  // Capture the actual serialized request, then bind two valid requests to the root's original Source.
  await f.h.owner.close()
  const writer = await openCollaborationAnalysisJournal(f.h.facility)
  const original = [...writer.records()].find(r => r.attempt_request_id === prepared.attempt_request_id)!
  const template = JSON.parse(original.manifest_json) as CollaborationAnalysisManifest
  onTestFinished(() => writer.close())
  for (const suffix of ['first', 'second']) {
    const manifest: CollaborationAnalysisManifest = { ...template, source: f.root.source, request: { ...template.request,
      system: `${template.request.system}${suffix}`, messages: [createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({
        source_message_id: f.root.source.source_message_id, source_revision: f.root.source.source_revision,
        original_message: f.root.source.original_message, active_mentions: f.root.source.active_mentions,
      }) }] })] } }
    const record = await writer.prepare(manifest, signal())
    const dispatched = await writer.dispatch(record, grant({ attempt_request_id: record.attempt_request_id,
      input_manifest_digest: record.input_manifest_digest, source_digest: record.source_digest }), signal())
    await writer.saveOutput(dispatched, JSON.stringify({ result: suffix }), signal())
  }
  await writer.close()
  await expect(f.owner.readRootOutput(f.target, signal())).rejects.toThrow('output_ambiguous')
  expect(f.h.calls()).toBe(0)
})
it('returns unavailable over private HTTP when the Profile has no planning owner', async () => {
  const h = await harness(), f = await httpFixture(h)
  const response = await f.post({ action: 'read_root_attempt', binding_key: binding, target: {} })
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({ error: 'unavailable' })
  expect(h.calls()).toBe(0)
})

it('lets a late valid grant finish before its own lease expires', async () => {
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const h = await harness(undefined, async () => { entered.resolve(undefined); await finish.promise })
  vi.useFakeTimers()
  try {
    const p = receipt(await h.owner.prepare(input(), binding, signal()))
    await vi.advanceTimersByTimeAsync(29000)
    const work = h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())
    const outcome = work.then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    finish.resolve(undefined)
    expect(await outcome).toEqual({ value: { jsonText: '{"intent":"discuss"}' } })
    expect(h.calls()).toBe(1)
    await expect(h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())).rejects.toThrow()
  } finally { finish.resolve(undefined); vi.useRealTimers() }
})


it('drains the cancelled model operation and its failure journal before close resolves', async () => {
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const h = await harness(undefined, async () => { entered.resolve(undefined); await finish.promise })
  onTestFinished(() => { finish.resolve(undefined) })
  const prepared = receipt(await h.owner.prepare(input(), binding, signal()))
  const dispatched = h.owner.dispatch(prepared.attempt_request_id, binding, permission(prepared), signal())
  const result = expect(dispatched).rejects.toThrow('collaboration_analysis_closed')
  await entered.promise
  let closed = false
  const closing = h.owner.close().then(() => { closed = true })
  await Promise.resolve(); await Promise.resolve()
  expect(closed).toBe(false)
  finish.resolve(undefined)
  await closing; await result
  const reopened = await openCollaborationAnalysisJournal(h.facility)
  expect([...reopened.failures()]).toMatchObject([{ reason: 'cancelled', input_manifest_digest: prepared.input_manifest_digest }])
  expect(h.calls()).toBe(1)
  await reopened.close()
})

it.each(['handoff', 'binding', 'missing_binding', 'expired', 'closed', 'reopened', 'membership', 'changed',
  'consumed', 'cancelled', 'deadline', 'reader_changed'] as const)(
  'ordinary live Source resume retains the original attempt and deadline: %s', async (mode) => {
    const h = await harness()
    let owner = h.owner
    vi.useFakeTimers()
    try {
      const p = receipt(await owner.prepare(input(), binding, signal(), binding))
      if (mode === 'expired') await vi.advanceTimersByTimeAsync(30001)
      if (mode === 'closed' || mode === 'reopened') await owner.close()
      if (mode === 'reopened') {
        owner = new DesktopCollaborationAnalysis(async () => { throw Error('must not recapture') }, h.open, signal(),
          undefined, undefined, undefined, undefined, undefined, undefined, h.readSource)
        onTestFinished(() => owner.close())
      }
      if (mode === 'membership') h.readSource.mockRejectedValueOnce(Error('membership'))
      if (mode === 'reader_changed') h.readSource.mockResolvedValueOnce(h.snapshot('message')).mockResolvedValueOnce({
        ...h.snapshot('message'), model_snapshot: { ...h.snapshot('message').model_snapshot, model: 'changed' },
      })
      if (mode === 'consumed') {
        const opened = h.open.mock.results.at(-1)
        if (!opened || opened.type !== 'return') throw Error('expected original journal')
        const journal = await opened.value
        await journal.dispatch([...journal.records()][0]!, permission(p), signal())
      }
      if (mode === 'deadline') await vi.advanceTimersByTimeAsync(20000)
      const resumed = owner.resumeSource(mode === 'changed' ? { ...input(), original_message: '@Guide changed' } : input(),
        'c'.repeat(64), mode === 'cancelled' ? AbortSignal.abort() : signal(),
        mode === 'missing_binding' ? undefined : mode === 'binding' ? 'b'.repeat(64) : binding)
      if (mode === 'handoff' || mode === 'deadline') {
        expect(await resumed).toEqual(p)
        expect(h.capture).toHaveBeenCalledTimes(1)
        if (mode === 'deadline') {
          await vi.advanceTimersByTimeAsync(10001)
          await expect(owner.dispatch(p.attempt_request_id, 'c'.repeat(64), permission(p), signal())).rejects.toThrow()
          expect(h.calls()).toBe(0)
        } else {
          await expect(owner.dispatch(p.attempt_request_id, binding, permission(p), signal())).rejects.toThrow()
          await owner.dispatch(p.attempt_request_id, 'c'.repeat(64), permission(p), signal())
          await expect(owner.resumeSource(input(), 'c'.repeat(64), signal(), binding)).rejects.toThrow()
          expect(h.calls()).toBe(1)
        }
      } else {
        await expect(resumed).rejects.toThrow()
        expect(h.calls()).toBe(0)
      }
    } finally { vi.useRealTimers() }
  },
)

it('refuses Source handoff without a membership reader even when the original call remains live', async () => {
  const h = await harness()
  const owner = new DesktopCollaborationAnalysis(h.capture, h.open, signal())
  onTestFinished(() => owner.close())
  await owner.prepare(input(), binding, signal(), binding)
  await expect(owner.resumeSource(input(), 'c'.repeat(64), signal(), binding)).rejects.toThrow('preparation_unavailable')
  expect(h.calls()).toBe(0)
})
it('refuses handoff when the original connection consumes dispatch during membership checking', async () => {
  const h = await harness(), p = receipt(await h.owner.prepare(input(), binding, signal(), binding))
  h.readSource.mockResolvedValueOnce(h.snapshot('message')).mockImplementationOnce(async () => {
    await h.owner.dispatch(p.attempt_request_id, binding, permission(p), signal())
    return h.snapshot('message')
  })
  await expect(h.owner.resumeSource(input(), 'c'.repeat(64), signal(), binding)).rejects.toThrow('preparation_unavailable')
  expect(h.calls()).toBe(1)
  await expect(h.owner.dispatch(p.attempt_request_id, 'c'.repeat(64), permission(p), signal())).rejects.toThrow()
  expect(h.calls()).toBe(1)
})

it('private HTTP hands off only the original Source preparation and rejects the previous connection dispatch', async () => {
  const h = await harness(), f = await httpFixture(h)
  const first = await f.post({ action: 'prepare', binding_key: binding, input: input(), resume_binding_key: binding })
  expect(first.status).toBe(200)
  const prepared = (await first.json() as { value: ReturnType<typeof receipt> }).value
  const resumed = await f.post({ action: 'resume_source', binding_key: 'c'.repeat(64), input: input(), resume_binding_key: binding })
  expect(resumed.status).toBe(200)
  expect(await resumed.json()).toEqual({ value: prepared })
  const previous = await f.post({ action: 'dispatch', binding_key: binding, attempt_request_id: prepared.attempt_request_id,
    grant: permission(prepared) })
  expect(previous.status).toBe(422)
  expect(h.calls()).toBe(0)
  const result = await f.post({ action: 'dispatch', binding_key: 'c'.repeat(64), attempt_request_id: prepared.attempt_request_id,
    grant: permission(prepared) })
  expect(result.status).toBe(200)
  expect(h.calls()).toBe(1)
  expect(h.capture).toHaveBeenCalledTimes(1)
})

it('reads ordinary Source output through private HTTP without preparing another model call', async () => {
  const h = await harness(), prepared = receipt(await h.owner.prepare(input(), binding, signal()))
  const f = await httpFixture(h)
  const { original_message: _text, active_mentions: _mentions, ...target } = input()
  const before = await f.post({ action: 'read_source_output', binding_key: binding, target })
  expect(before.status).toBe(200)
  expect(await before.json()).toMatchObject({ value: { state: 'missing', descriptor: prepared.descriptor } })
  const originalGrant = permission(prepared)
  const result = await h.owner.dispatch(prepared.attempt_request_id, binding, originalGrant, signal())
  const response = await f.post({ action: 'read_source_output', binding_key: binding, target })
  expect(response.status).toBe(200)
  const body = await response.json() as { value: { state: string; dispatch: unknown; output_digest: string; json_base64url: string } }
  expect(body.value.state).toBe('saved')
  expect(body.value.dispatch).toEqual(originalGrant)
  expect(body.value.output_digest).toBe(createHash('sha256').update(result.jsonText, 'utf8').digest('hex'))
  expect(Buffer.from(body.value.json_base64url, 'base64url').toString('utf8')).toBe(result.jsonText)
  expect(body.value).not.toHaveProperty('manifest_json')
  expect(body.value).not.toHaveProperty('root')
  expect(h.calls()).toBe(1)
  expect(h.capture).toHaveBeenCalledTimes(1)
  expect(h.readSource).toHaveBeenCalledTimes(4)
})
it('reopens ordinary Source output with its expired original grant and no executable call', async () => {
  const h = await harness(), prepared = receipt(await h.owner.prepare(input(), binding, signal()))
  const originalGrant = permission(prepared)
  await h.owner.dispatch(prepared.attempt_request_id, binding, originalGrant, signal())
  await h.owner.close()
  const recovered = new DesktopCollaborationAnalysis(async () => { throw Error('must not recapture') },
    () => openCollaborationAnalysisJournal(h.facility), signal(),
    undefined, undefined, undefined, undefined, undefined, undefined, h.readSource)
  onTestFinished(() => recovered.close())
  const { original_message: _text, active_mentions: _mentions, ...target } = input()
  vi.useFakeTimers()
  try {
    vi.setSystemTime(Date.parse(originalGrant.lease_expires_at) + 1)
    const result = await recovered.readSourceOutput(target, signal())
    expect(result.state).toBe('saved')
    if (result.state !== 'saved') throw Error('expected persisted output')
    expect(result.dispatch).toEqual(originalGrant)
    expect(h.calls()).toBe(1)
    expect(h.capture).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})
it.each(['revoked', 'final_membership', 'changed', 'cancelled', 'lifetime', 'closed', 'closing', 'invalid', 'unknown'] as const)(
  'refuses ordinary Source output after %s without invoking a model', async (mode) => {
    const h = await harness()
    await h.capture(input(), signal())
    const { original_message: _text, active_mentions: _mentions, ...target } = input()
    const cancel = new AbortController()
    if (mode === 'revoked') h.readSource.mockRejectedValueOnce(Error('membership'))
    if (mode === 'final_membership') h.readSource.mockResolvedValueOnce(h.snapshot('message')).mockRejectedValueOnce(Error('membership'))
    if (mode === 'lifetime') h.lifetime.abort()
    if (mode === 'changed') h.readSource.mockResolvedValueOnce(h.snapshot('message')).mockResolvedValueOnce({ ...h.snapshot('message'), original_message: 'changed' })
    if (mode === 'cancelled') cancel.abort()
    if (mode === 'closed') await h.owner.close()
    if (mode === 'closing') h.readSource.mockResolvedValueOnce(h.snapshot('message')).mockImplementationOnce(async () => { await h.owner.close(); return h.snapshot('message') })
    const request = mode === 'invalid' ? { ...target, json_text: '{}' } : mode === 'unknown' ? { ...target, source_message_id: 'missing' } : target
    await expect(h.owner.readSourceOutput(request, cancel.signal)).rejects.toThrow()
    expect(h.calls()).toBe(0)
    expect(h.capture).toHaveBeenCalledTimes(1)
  },
)

it('refuses ordinary Source output without a membership reader', async () => {
  const h = await harness()
  const owner = new DesktopCollaborationAnalysis(h.capture, h.open, signal())
  onTestFinished(() => owner.close())
  const { original_message: _text, active_mentions: _mentions, ...target } = input()
  await expect(owner.readSourceOutput(target, signal())).rejects.toThrow('source_output_unavailable')
  expect(h.calls()).toBe(0)
  expect(h.open).not.toHaveBeenCalled()
  expect(h.capture).not.toHaveBeenCalled()
})
it('keeps original Source output distinct from subsequent clarification output', async () => {
  const h = await harness(), original = receipt(await h.owner.prepare(input('original'), binding, signal()))
  const originalGrant = permission(original)
  const originalOutput = await h.owner.dispatch(original.attempt_request_id, binding, originalGrant, signal())
  await h.owner.captureReply(replyInput(), binding, signal())
  const clarification = receipt(await h.owner.prepareClarification(context(h), binding, signal()))
  await h.owner.dispatch(clarification.attempt_request_id, binding, { ...permission(clarification), expected_plan_revision: '3' }, signal())
  const { original_message: _text, active_mentions: _mentions, ...target } = input('original')
  const recovered = await h.owner.readSourceOutput(target, signal())
  expect(recovered.state).toBe('saved')
  if (recovered.state !== 'saved') throw Error('expected original output')
  expect(recovered.dispatch).toEqual(originalGrant)
  expect(Buffer.from(recovered.json_base64url, 'base64url').toString('utf8')).toBe(originalOutput.jsonText)
  expect(h.calls()).toBe(2)
})
it('refuses multiple original Source outputs instead of selecting the first saved analysis', async () => {
  const h = await harness(), prepared = receipt(await h.owner.prepare(input(), binding, signal()))
  await h.owner.close()
  const writer = await openCollaborationAnalysisJournal(h.facility)
  const template = JSON.parse([...writer.records()][0]!.manifest_json) as CollaborationAnalysisManifest
  try {
    for (const suffix of ['first', 'second']) {
      const record = await writer.prepare({ ...template, request: { ...template.request, system: `${template.request.system}${suffix}` } }, signal())
      const dispatched = await writer.dispatch(record, grant({
        attempt_request_id: record.attempt_request_id, input_manifest_digest: record.input_manifest_digest,
        source_digest: record.source_digest,
      }), signal())
      await writer.saveOutput(dispatched, JSON.stringify({ result: suffix }), signal())
    }
  } finally { await writer.close() }
  const recovered = new DesktopCollaborationAnalysis(h.capture, h.open, signal(),
    undefined, undefined, undefined, undefined, undefined, undefined, h.readSource)
  onTestFinished(() => recovered.close())
  const { snapshot_digest: _digest, ...target } = prepared.descriptor
  await expect(recovered.readSourceOutput(target, signal())).rejects.toThrow('output_ambiguous')
  expect(h.calls()).toBe(0)
  expect(h.capture).toHaveBeenCalledTimes(1)
})
