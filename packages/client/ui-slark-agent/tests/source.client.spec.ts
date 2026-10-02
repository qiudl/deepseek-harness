// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { afterEach, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { apply, inject } from '../src/client/index.ts'

const session = { sessionId: 'test-session' as SessionId }
const agent = { assignment_id: 'assignment-1', project_id: 'project-1', agent_id: 'agent-1',
  enterprise_id: 'enterprise-1', enterprise_name: 'Company', project_name: 'Project',
  name: 'Test Agent', publication_version: 2 }

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
})

it('shows same-name Agents by stable identity and blocks ordinary model submission', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const ctx = new Context()
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', { registerSource(value: InputTriggerSource) {
    source = value
    return () => { source = undefined }
  } })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('slots', { inject: () => () => undefined, register: () => () => undefined } as never)
  let draft = ''
  let occurrences: Array<{
    source: string
    ref: string
    offset: number
    length: number
    clipboardText: string
  }> = []
  ctx.provide('sessions', { scope: () => ctx, scopeOf: () => session.sessionId } as never)
  ctx.provide('conversation', { input: { for: () => ({ state: {
    getSnapshot: () => ({ draft, occurrences }),
  } }) } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  if (!source) throw new Error('Slark Agent source did not register')
  const registered = source
  const fetchDirectory = vi.fn(async () => ({ ok: true as const, invocationAvailable: true, items: [
    agent, { ...agent, assignment_id: 'assignment-2', agent_id: 'agent-2' },
  ] }))
  const invoke = vi.fn(async () => ({ ok: true as const,
    value: { invocation_id: 'invocation-1', state: 'accepted' } }))
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgents: fetchDirectory,
    invokeEnterpriseAgent: invoke })
  fetchDirectory.mockResolvedValueOnce({ ok: true, invocationAvailable: false, items: [agent] })
  expect(await registered.candidates(session, { query: '', position: 'inline',
    drilled: false, signal: new AbortController().signal })).toEqual([])
  const rows = await registered.candidates(session, { query: 'test', position: 'inline',
    drilled: false, signal: new AbortController().signal })
  expect(rows).toHaveLength(2)
  expect(rows[0]?.name).not.toBe(rows[1]?.name)
  expect(rows[0]?.description).toBe('Company / Project')
  expect(fetchDirectory).toHaveBeenCalledTimes(2)
  const picked = registered.onPick({ candidate: rows[1]!, session, position: 'inline',
    via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })
  expect(picked).toMatchObject({ insert: { source: 'slark-agent', label: 'Test Agent · Project',
    clipboardText: '@Test Agent · Project' } })
  if (!picked || typeof picked !== 'object' || !('insert' in picked))
    throw new Error('Agent reference not inserted')
  expect(JSON.parse(picked.insert.ref)).toMatchObject({ assignment_id: 'assignment-2', agent_id: 'agent-2' })
  expect((JSON.parse(picked.insert.ref) as { logical_key: string }).logical_key).toMatch(/^[0-9a-f-]{36}$/)
  draft = '@Test Agent question'
  const legacy = JSON.parse(picked.insert.ref) as { logical_key: string; logical_key_version?: number }
  Reflect.deleteProperty(legacy, 'logical_key_version')
  occurrences = [{ source: 'slark-agent', ref: JSON.stringify(legacy), offset: 0,
    length: '@Test Agent'.length, clipboardText: '@Test Agent' }]
  const outcome = await registered.matchEnter?.(session, draft, new AbortController().signal,
    { attachments: 0 })
  expect(outcome).toHaveProperty('claim')
  if (!outcome || typeof outcome !== 'object' || !('claim' in outcome))
    throw new Error('Agent send was not claimed')
  expect(await outcome.claim.submit('', ctx, [])).toMatchObject({ kind: 'success' })
  expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
    session_id: session.sessionId, assignment_id: 'assignment-2', agent_id: 'agent-2',
    question: 'question',
    logical_key: legacy.logical_key,
  }))
  await expect(registered.matchEnter?.(session, draft, new AbortController().signal,
    { attachments: 1 })).rejects.toThrow()
  occurrences = [{ ...occurrences[0]!, source: 'reference' }]
  expect(await registered.matchEnter?.(session, draft, new AbortController().signal,
    { attachments: 0 })).toBeUndefined()
  await expect(registered.codec?.serialize(picked.insert.ref, new AbortController().signal))
    .rejects.toThrow()
  await fiber.dispose()
  expect(source).toBeUndefined()
})

it('refuses unavailable, malformed, changed, and ambiguous Agent submissions', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const ctx = new Context()
  let source: InputTriggerSource | undefined
  let slotSession: unknown
  ctx.provide('inputTriggers', { registerSource(value: InputTriggerSource) {
    source = value
    return () => { source = undefined }
  } })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('slots', { inject: (_name: string, register: () => () => void) => register(),
    register: (config: { inject: (sessionId: string) => unknown }) => {
      slotSession = config.inject(session.sessionId)
      return () => undefined
    } } as never)
  let draft = '@Test Agent question'
  let occurrences: Array<{
    source: string
    ref: string
    offset: number
    length: number
    clipboardText: string
  }> = []
  let scoped = true
  let currentSession = session.sessionId
  ctx.provide('sessions', { scope: () => scoped ? ctx : undefined,
    scopeOf: () => currentSession } as never)
  ctx.provide('conversation', { input: { for: () => ({ state: {
    getSnapshot: () => ({ draft, occurrences }),
  } }) } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  if (!source) throw new Error('Slark Agent source did not register')
  const registered = source
  expect(slotSession).toEqual({ sessionId: session.sessionId })
  const options = { query: '', position: 'inline' as const, drilled: false,
    signal: new AbortController().signal }
  vi.stubGlobal('window', undefined)
  expect(await registered.candidates(session, options)).toEqual([])
  vi.unstubAllGlobals()
  expect(await registered.candidates(session, options)).toEqual([])
  const directory = vi.fn(async () => ({ ok: true as const, invocationAvailable: true,
    items: [agent] }))
  const invoke = vi.fn(async () => ({ ok: true as const,
    value: { invocation_id: 'invocation-1', state: 'accepted' } }))
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgents: directory,
    invokeEnterpriseAgent: invoke })
  directory.mockResolvedValueOnce({ ok: true, invocationAvailable: false, items: [agent] })
  expect(await registered.candidates(session, options)).toEqual([])
  const aborted = new AbortController()
  aborted.abort()
  expect(await registered.candidates(session, { ...options, signal: aborted.signal })).toEqual([])
  const rows = await registered.candidates(session, { ...options, query: 'company' })
  expect(rows).toHaveLength(1)
  const missingValue = { ...rows[0]! }
  Reflect.deleteProperty(missingValue, 'value')
  expect(registered.onPick({ candidate: missingValue, session,
    position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, draftRev: 1 } })).toBeUndefined()
  const pick = (value: string) => registered.onPick({ candidate: { ...rows[0]!, value },
    session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, draftRev: 1 } })
  expect(pick('{')).toBeUndefined()
  expect(pick('[]')).toBeUndefined()
  expect(pick('{}')).toBeUndefined()
  expect(pick(JSON.stringify({ ...agent, logical_key_version: 3 }))).toBeUndefined()
  const picked = pick(rows[0]!.value!)
  if (!picked || typeof picked !== 'object' || !('insert' in picked))
    throw new Error('Agent reference not inserted')
  const mention = { source: 'slark-agent', ref: picked.insert.ref, offset: 0,
    length: '@Test Agent'.length, clipboardText: '@Test Agent' }
  occurrences = [mention]
  scoped = false
  expect(await registered.matchEnter?.(session, draft, options.signal,
    { attachments: 0 })).toBeUndefined()
  scoped = true
  occurrences = [{ ...mention, offset: 1 }]
  expect(await registered.matchEnter?.(session, draft, options.signal,
    { attachments: 0 })).toBeUndefined()
  occurrences = [mention]
  expect(await registered.matchEnter?.(session, 'other draft', options.signal,
    { attachments: 0 })).toBeUndefined()
  occurrences = [{ ...mention, ref: JSON.stringify({ ...agent, logical_key: 'bad key' }) }]
  await expect(registered.matchEnter?.(session, draft, options.signal,
    { attachments: 0 })).rejects.toThrow()
  occurrences = [mention]
  draft = '@Test Agent'
  await expect(registered.matchEnter?.(session, draft, options.signal,
    { attachments: 0 })).rejects.toThrow()
  draft = '@Test Agent question'
  occurrences = [mention, { ...mention, source: 'reference' }]
  await expect(registered.matchEnter?.(session, draft, options.signal,
    { attachments: 0 })).rejects.toThrow()
  occurrences = [mention]
  const claim = async () => {
    const result = await registered.matchEnter?.(session, draft, options.signal,
      { attachments: 0 })
    if (!result || typeof result !== 'object' || !('claim' in result))
      throw new Error('Agent send was not claimed')
    return result.claim
  }
  const first = await claim()
  currentSession = 'other-session' as SessionId
  expect(await first.submit('', ctx, [])).toMatchObject({ kind: 'error' })
  currentSession = session.sessionId
  draft = '@Test Agent changed'
  expect(await first.submit('', ctx, [])).toMatchObject({ kind: 'error' })
  draft = '@Test Agent question'
  occurrences = [{ ...mention, ref: 'changed' }]
  expect(await first.submit('', ctx, [])).toMatchObject({ kind: 'error' })
  occurrences = [mention]
  expect(await first.submit('changed', ctx, [])).toMatchObject({ kind: 'error' })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgents: directory })
  expect(await first.submit('', ctx, [])).toMatchObject({ kind: 'error' })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgents: directory,
    invokeEnterpriseAgent: vi.fn(async () => ({ ok: false, errorCode: 'revoked' })) })
  expect(await first.submit('', ctx, [])).toMatchObject({ kind: 'error' })
  expect(registered.codec?.clipboardText?.(mention.ref)).toBe('@Test Agent · Project')
  expect(registered.codec?.clipboardText?.(JSON.stringify({ ...agent, project_name: undefined }))).toBe('@Test Agent')
  expect(registered.codec?.clipboardText?.('{')).toBe('@')
  await fiber.dispose()
})
