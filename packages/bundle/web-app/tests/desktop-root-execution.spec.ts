import { MessageId } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopCollaborationAnalysis, handleDesktopCollaborationAnalysisRequest } from '../src/desktop-collaboration-analysis.ts'
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
  expect(noModel).not.toHaveBeenCalled()
})
