import { MessageId } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopCollaborationAnalysis, handleDesktopCollaborationAnalysisRequest } from '../src/desktop-collaboration-analysis.ts'
import type { TaskCoordinationActualAccount } from '../src/desktop-task-coordination.ts'
it.each(['root_execution_journal', 'root_feedback'] as const)('requires the private token and owner lifetime for %s', async (action) => {
  const lifetime = new AbortController(), journal = vi.fn(async () => null)
  const observation = { message_id: MessageId('feedback-test'), status: 'queued' as const, event_count: 1, log_digest: 'a'.repeat(64), continuation_observed: false }
  const feedback = vi.fn(async () => observation)
  const execution = action === 'root_feedback' ? feedback : journal
  const noModel = vi.fn(async (): Promise<never> => { throw Error('model must not run') })
  const owner = new DesktopCollaborationAnalysis(noModel, noModel, lifetime.signal, undefined, undefined, undefined, journal, feedback)
  const token = 'A'.repeat(43)
  const server = createServer((req, res) => { void handleDesktopCollaborationAnalysisRequest(req, res, token, owner) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    await owner.close(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const operation = { action: 'read', target: {}, selection: {} }
  const post = (authorization: string, body: unknown = { action, operation, binding_key: 'b'.repeat(64) }) => fetch(url,
    { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await post('')).status).toBe(403)
  expect((await post('Bearer ' + 'B'.repeat(43))).status).toBe(403)
  expect(execution).not.toHaveBeenCalled()
  const response = await post('Bearer ' + token)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ value: action === 'root_feedback' ? observation : null })
  expect(execution).toHaveBeenCalledWith(operation, expect.any(AbortSignal))
  expect((await post('Bearer ' + token, { action, operation, binding_key: 'b'.repeat(64), receipt: {} })).status).toBe(400)
  lifetime.abort()
  expect((await post('Bearer ' + token)).status).toBe(422)
  expect(execution).toHaveBeenCalledTimes(1)
  expect(noModel).not.toHaveBeenCalled()
})

it.each(['caller', 'lifetime'] as const)('keeps the parent Account and propagates %s cancellation to the consumer', async (cancel) => {
  const caller = new AbortController(), lifetime = new AbortController()
  const entered = Promise.withResolvers<AbortSignal>()
  const reason = Error('fixture cancellation')
  const noModel = vi.fn(async (): Promise<never> => { throw Error('model must not run') })
  const feedback = vi.fn(async (): Promise<never> => { throw Error('feedback must not run') })
  const consumption = vi.fn((_operation: unknown, signal: AbortSignal, _account?: TaskCoordinationActualAccount): Promise<never> => {
    entered.resolve(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(reason) }, { once: true })
    })
  })
  const owner = new DesktopCollaborationAnalysis(noModel, noModel, lifetime.signal,
    undefined, undefined, undefined, undefined, feedback, consumption)
  onTestFinished(async () => { caller.abort(); lifetime.abort(); await owner.close() })
  const account: TaskCoordinationActualAccount = {
    authorityEnvironmentId: '11111111-1111-4111-8111-111111111111', accountIssuer: 'https://account.fixture',
    accountSubject: 'owner', accountBindingId: 'binding', accountBindingVersion: 1,
    hostProfileId: '22222222-2222-4222-8222-222222222222',
  }
  const operation = { action: 'consumer_start' }
  const pending = owner.rootFeedback(operation, caller.signal, account)
  const rejected = expect(pending).rejects.toBe(reason)
  const active = await entered.promise
  expect(consumption).toHaveBeenCalledWith(operation, active, account)
  expect(consumption.mock.calls[0]?.[2]).toBe(account)
  expect(active.aborted).toBe(false)
  if (cancel === 'caller') caller.abort(reason)
  else lifetime.abort(reason)
  await rejected
  expect(active.aborted).toBe(true)
  expect(active.reason).toBe(reason)
  await expect(owner.rootFeedback(operation, caller.signal, account)).rejects.toBe(reason)
  expect(consumption).toHaveBeenCalledTimes(1)
  expect(feedback).not.toHaveBeenCalled()
  expect(noModel).not.toHaveBeenCalled()
})

it('refuses missing private owners and closed lifetimes before calling Session operations', async () => {
  const noModel = vi.fn(async (): Promise<never> => { throw Error('no model') })
  const owner = new DesktopCollaborationAnalysis(noModel, noModel, new AbortController().signal)
  onTestFinished(async () => { await owner.close() })
  await expect(owner.executionJournal({}, new AbortController().signal)).rejects.toThrow('journal_unavailable')
  await expect(owner.rootFeedback({}, new AbortController().signal)).rejects.toThrow('feedback_unavailable')
  await expect(owner.prepareRoot({ namespace_id: 'n2_' + 'a'.repeat(64), continuation_policy: 'display_only', source: {} }, 'b'.repeat(64), new AbortController().signal)).rejects.toThrow('capture_unavailable')
  const feedback = vi.fn(async (): Promise<never> => { throw Error('invalid operation') })
  const partial = new DesktopCollaborationAnalysis(noModel, noModel, new AbortController().signal, undefined, undefined, undefined,
    undefined, feedback)
  onTestFinished(async () => { await partial.close() })
  await expect(partial.rootFeedback({ action: 'consumer_read' }, new AbortController().signal)).rejects.toThrow('consumption_unavailable')
  await expect(partial.rootFeedback(null, new AbortController().signal)).rejects.toThrow('invalid operation')
  expect(feedback).toHaveBeenCalledTimes(1)
  const consumption = vi.fn(async (): Promise<never> => { throw Error('consumer refused') })
  const installed = new DesktopCollaborationAnalysis(noModel, noModel, new AbortController().signal,
    undefined, undefined, undefined, undefined, feedback, consumption)
  onTestFinished(() => installed.close())
  const operation = { action: 'consumer_start' }
  await expect(installed.rootFeedback(operation, new AbortController().signal)).rejects.toThrow('consumer refused')
  expect(consumption).toHaveBeenCalledWith(operation, expect.any(AbortSignal), undefined)
  expect(feedback).toHaveBeenCalledTimes(1)
  expect(noModel).not.toHaveBeenCalled()
})
