/** The actual input consumer rejects a caller-created capability before waking or loading an Agent. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { openPairedTaskTargetJournal } from '../src/paired-task-target-journal.ts'
import { PairedTaskTargetConsumer } from '../src/paired-task-target-consumer.ts'

it('refuses a public DTO without an actual owned provider and creates no admission or model input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paired-consumer-denied-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root); ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), journal = await openPairedTaskTargetJournal(facility)
  const lifetime = new AbortController(), consumer = new PairedTaskTargetConsumer(ctx, async () => journal, lifetime.signal)
  try {
    await expect(consumer.start(Object.freeze({ kind: 'paired-task-step-capability' }), new AbortController().signal))
      .rejects.toThrow('paired_target_provider_unavailable')
  } finally {
    await consumer.close(); await facility.closeAll(); await backend.close(); await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { hostTaskTargetDescriptorDigest, hostTaskTargetOriginalStepHash, hostTaskStepPayloadDigest,
  hostTaskReadyAdmissionDirectiveDigest, hostTaskTargetConsumeChallengeDigest,
  parseHostTaskTargetDescriptor, parseHostTaskReadyAdmissionDirective, parseHostTaskTargetStepBody,
  parseHostTaskTargetConsumeChallengeForProposal, parseHostTaskTargetConsumeReceipt } from '@deepseek-ai/dsh-host-control-protocol'

it.each(['normal', 'bad_prefix', 'prepare_failure', 'authority_lost', 'close_prepare', 'detach_after_claim', 'tamper_before_inbox', 'abort_before_claim'] as const)(
  'uses actual Agent persistence and owns cleanup for %s', async (scenario) => {
  // Source signatures and provider lifecycle are controlled; this tests the real Controller inbox/checkpoint only.
    const root = await mkdtemp(join(tmpdir(), 'paired-consumer-real-')), ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root); ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' }), journal = await openPairedTaskTargetJournal(facility)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([scenario === 'detach_after_claim' ? 'hang' : textResponse('controlled model response')]); ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('paired-session'), { provider: 'mock', model: 'mock' })
    const session = agent.session, snapshot = await ctx.agentLoop.readOriginalInvocationEntrySession(agent)
    if (!snapshot) throw Error('missing actual exclusive Session')
    const data: unknown = JSON.parse(await readFile(new URL('../../../host/control-protocol/tests/fixtures/task-target-v1.json', import.meta.url), 'utf8'))
    const field = (key: string): unknown => { if (!data || typeof data !== 'object') throw Error('missing vector'); return Reflect.get(data, key) }
    const canonical = field('canonicalStepBody')
    if (!canonical || typeof canonical !== 'object') throw Error('missing canonical body')
    const body = parseHostTaskTargetStepBody(Reflect.get(canonical, 'bytes')), stepPayloadDigest = hostTaskStepPayloadDigest(JSON.stringify(body))
    const original = parseHostTaskTargetDescriptor(field('descriptor')), readyLiteral = parseHostTaskReadyAdmissionDirective(field('ready'))
    const originalStep = { ...readyLiteral.originalStep, stepPayloadDigest }
    const draft = { ...original, target: { ...original.target, sessionId: agent.id, journalEpoch: journal.epoch,
      prefixEventCount: snapshot.logOffset + (scenario === 'bad_prefix' ? 1 : 0), prefixLogDigest: snapshot.prefixLogDigest },
    originalStepHash: hostTaskTargetOriginalStepHash(originalStep) }
    const descriptor = parseHostTaskTargetDescriptor({ ...draft, descriptorDigest: hostTaskTargetDescriptorDigest(draft) })
    const proposal = parseHostTaskReadyAdmissionDirective({ ...readyLiteral, target: descriptor.target,
      descriptorDigest: descriptor.descriptorDigest, originalStep, stepPayloadDigest })
    const challenge = parseHostTaskTargetConsumeChallengeForProposal({ ...parseHostTaskTargetConsumeChallengeForProposal(
      field('consumeChallenge'), field('ready')),
    target: descriptor.target, descriptorDigest: descriptor.descriptorDigest,
    readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(proposal) }, proposal)
    const receipt = parseHostTaskTargetConsumeReceipt({ ...parseHostTaskTargetConsumeReceipt(field('consumeReceipt')),
      target: descriptor.target, descriptorDigest: descriptor.descriptorDigest, stepPayloadDigest,
      readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(proposal),
      challengeDigest: hostTaskTargetConsumeChallengeDigest(challenge) })
    const unary = new AbortController(), worker = new AbortController(), signal = unary.signal
    const projection = await journal.prepare(descriptor, signal)
    const intent = await journal.consumeIntent(projection.itemId, proposal, challenge, signal)
    const admission = await journal.recordSourceConsumption(intent.itemId, receipt, signal)
    let entered!: () => void
    const preparing = new Promise<void>((resolve) => { entered = resolve })
    const capability = Object.freeze({ kind: 'paired-task-step-capability' as const }); let taken = false, finished = 0, current = true
    ctx.provide('pairedTaskTargetConsumerHost', { take(token) {
      if (taken || token !== capability) throw Error('not original capability')
      taken = true
      return { agent, session, admission, proposal, body, signal: worker.signal, assertCurrent() { if (!current) throw Error('controlled_authority_lost') },
        async prepare(owned?: AbortSignal) {
          if (scenario === 'prepare_failure') throw Error('controlled_prepare_failure')
          if (scenario !== 'close_prepare') return
          entered()
          if (!owned) throw Error('controlled_missing_owned_signal')
          await new Promise<void>((_resolve, reject) => {
            if (owned.aborted) { reject(owned.reason instanceof Error ? owned.reason : Error('controlled_abort')); return }
            owned.addEventListener('abort', () =>{  reject(owned.reason instanceof Error ? owned.reason : Error('controlled_abort')) }, { once: true })
          })
        },
        async starting() { if (scenario === 'authority_lost') current = false },
        async settling() {}, async finished() { finished++ } }
    } })
    if (scenario === 'abort_before_claim') ctx.on('agent/status', ({ status }) => {
      if (status === 'running' && !unary.signal.aborted) unary.abort(Error('controlled_unary_cancel'))
    })
    let changedMessage = false
    if (scenario === 'tamper_before_inbox') ctx.on('agent/pre-inbox', ({ message }) => {
      const segment = message.content[0]
      if (segment && message.source.kind === 'slark-task-target-step')
        changedMessage = Reflect.set(segment, 'text', 'changed original instruction')
    })
    const consumer = new PairedTaskTargetConsumer(ctx, async () => journal, worker.signal)
    onTestFinished(async () => { await consumer.close(); await journal.close(); await facility.closeAll(); await backend.close()
      await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    // Runs in the adapter itself, after the middleware and before any provider text is yielded.
    let modelEntered!: () => void
    const modelEntry = new Promise<void>((resolve) => { modelEntered = resolve })
    const stream = adapter.stream.bind(adapter)
    adapter.stream = (options) => {
      if (scenario === 'abort_before_claim') {
        expect(JSON.stringify(options)).not.toContain(body.text)
        return stream(options)
      }
      expect(journal.admission(intent.itemId)).toMatchObject({ state: 'claimed',
        messageId: 'paired-step:' + admission.admissionId, turn: 1, step: 1 })
      modelEntered()
      return stream(options)
    }
    if (scenario === 'abort_before_claim') {
      await expect(consumer.start(capability, signal)).rejects.toThrow('controlled_unary_cancel')
      expect(agent.inbox.nextStep).toHaveLength(0); expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(adapter.requests).toHaveLength(0); expect(finished).toBe(1)
      agent.send(createUserMessage({ content: [{ type: 'text', text: 'ordinary recovery input' }], source: { kind: 'user' } }),
        'next-step', true)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      return
    }
    if (scenario === 'detach_after_claim') {
      const run = consumer.begin(capability, signal)
      expect((await run.accepted).state).toBe('claimed')
      unary.abort(Error('controlled_unary_finished'))
      await modelEntry
      expect(agent.status).toBe('running')
      const completion = expect(run.completion).rejects.toThrow('paired_target_consumer_closed')
      await consumer.close(); await completion
      expect(finished).toBe(1); expect(agent.status).toBe('idle')
      return
    }
    if (scenario === 'close_prepare') {
      const result = consumer.start(capability, signal)
      const rejection = expect(result).rejects.toThrow('paired_target_consumer_closed')
      await preparing
      await consumer.close(); await rejection
      expect(finished).toBe(1); expect(adapter.requests).toHaveLength(0)
      return
    }
    if (scenario !== 'normal' && scenario !== 'tamper_before_inbox') {
      const reason = scenario === 'bad_prefix' ? 'session_changed' : scenario === 'prepare_failure' ? 'prepare_failure' : 'authority_lost'
      await expect(consumer.start(capability, signal)).rejects.toThrow(reason)
      expect(adapter.requests).toHaveLength(0); expect(finished).toBe(1)
      expect(journal.admission(intent.itemId)?.state).toBe(scenario === 'authority_lost' ? 'start_intent' : 'source_consumed')
      return
    }
    const result = await consumer.start(capability, signal)
    expect(changedMessage).toBe(false)
    expect(result.state).toBe('claimed'); expect(adapter.requests).toHaveLength(1); expect(finished).toBe(1)
    await expect(consumer.start(capability, signal)).rejects.toThrow('not original capability')
    expect(adapter.requests).toHaveLength(1)
  })

it('blocks a cold recovered paired input before an ordinary wake without opening a grant journal or creating a capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paired-consumer-cold-')), first = new Context(), second = new Context()
  const lifetime = new AbortController(), id = SessionId('paired-cold-session')
  const boot = async (ctx: Context) => {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root: join(root, ctx === first ? 'sessions' : 'captured'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('must not reach provider')])
    ctx.llm.registerAdapter(['mock'], adapter)
    return adapter
  }
  await boot(first)
  const original = await first.agentLoop.create(id, { provider: 'mock', model: 'mock' })
  original.send(createUserMessage({ content: [{ type: 'text', text: 'old paired input may never execute after recovery' }],
    source: { kind: 'slark-task-target-step', commandId: 'old-command', admissionId: 'old-admission',
      invocationId: 'old-invocation', executionKey: 'old-execution', stepPayloadDigest: 'a'.repeat(64) } }), 'next-step', false)
  expect(await first.sessions.flush(original.session)).toBe(true)
  await cp(join(root, 'sessions'), join(root, 'captured'), { recursive: true })
  await first.fiber.dispose()
  const adapter = await boot(second)
  let opens = 0
  const consumer = new PairedTaskTargetConsumer(second, async () => { opens++; throw Error('unexpected writer journal open') }, lifetime.signal)
  onTestFinished(async () => { await consumer.close(); await second.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await consumer.activate()
  const handle = await second.agentLoop.resume(second, { resumeSessionId: id })
  expect(handle.agent.inbox.nextStep).toHaveLength(1)
  handle.agent.send(createUserMessage({ content: [{ type: 'text', text: 'ordinary input after restart' }], source: { kind: 'user' } }),
    'next-step', true)
  await handle.agent.whenIdle()
  expect(adapter.requests).toHaveLength(0)
  expect(opens).toBe(0)
})
