// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

const session = { sessionId: 'test-session' as SessionId }
const agent = { assignment_id: 'assignment-1', project_id: 'project-1', agent_id: 'agent-1',
  enterprise_id: 'enterprise-1', enterprise_name: 'Company', project_name: 'Project',
  name: 'Test Agent', publication_version: 2 }

afterEach(() => {
  Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
})

it('shows same-name Agents by stable identity and blocks ordinary model submission', async () => {
  const ctx = new Context()
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', { registerSource(value: InputTriggerSource) {
    source = value
    return () => { source = undefined }
  } })
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  if (!source) throw new Error('Slark Agent source did not register')
  const registered = source
  const fetchDirectory = vi.fn(async () => ({ ok: true as const, items: [
    agent, { ...agent, assignment_id: 'assignment-2', agent_id: 'agent-2' },
  ] }))
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgents: fetchDirectory })
  const rows = await registered.candidates(session, { query: 'test', position: 'inline',
    drilled: false, signal: new AbortController().signal })
  expect(rows).toHaveLength(2)
  expect(rows[0]?.name).not.toBe(rows[1]?.name)
  expect(rows[0]?.description).toBe('Company / Project')
  expect(fetchDirectory).toHaveBeenCalledOnce()
  const picked = registered.onPick({ candidate: rows[1]!, session, position: 'inline',
    via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })
  expect(picked).toMatchObject({ insert: { source: 'slark-agent', label: 'Test Agent' } })
  if (!picked || !('insert' in picked)) throw new Error('Agent reference not inserted')
  expect(JSON.parse(picked.insert.ref)).toMatchObject({ assignment_id: 'assignment-2', agent_id: 'agent-2' })
  await expect(registered.codec?.serialize(picked.insert.ref, new AbortController().signal))
    .rejects.toThrow()
  await fiber.dispose()
  expect(source).toBeUndefined()
})
