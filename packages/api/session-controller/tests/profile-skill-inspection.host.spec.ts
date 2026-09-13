import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionSkillCatalog } from '../src/skill-catalog.ts'

it('reads model-only skills in the default standing preset without a Session or project cwd', async () => {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  const scope = { id: 'standing' }
  const standingKeyFor = vi.fn(async () => scope)
  const skill = { name: 'demo', description: 'demo', content: 'Instructions', source: 'user-dsh', provider: 'filesystem',
    path: '/profile/skills/demo/SKILL.md', invocation: { modelInvocable: true, userInvocable: false } }
  const get = vi.fn(async () => skill)
  ctx.provide('agentPresets', { standingKeyFor } as never); ctx.provide('skills', { get } as never)
  const signal = new AbortController().signal
  expect(await new SessionSkillCatalog(ctx).inspectProfile({ name: 'demo' }, signal)).toEqual({ skill })
  expect(standingKeyFor).toHaveBeenCalledWith()
  expect(get).toHaveBeenCalledWith('demo', { scope, signal })
})
it('does not fall back to a global catalog when the default preset cannot mount', async () => {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  const get = vi.fn()
  ctx.provide('agentPresets', { standingKeyFor: async () => { throw Error('broken preset') } } as never)
  ctx.provide('skills', { get } as never)
  await expect(new SessionSkillCatalog(ctx).inspectProfile({ name: 'demo' }, new AbortController().signal)).rejects.toThrow()
  expect(get).not.toHaveBeenCalled()
})
it('rejects a missing preset owner and cancellation before lookup', async () => {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  const catalog = new SessionSkillCatalog(ctx)
  await expect(catalog.inspectProfile({ name: 'demo' }, new AbortController().signal)).rejects.toThrow()
  await expect(catalog.inspectProfile({ name: 'demo' }, AbortSignal.abort())).rejects.toThrow()
})
it('lists complete invocation-neutral summaries in the default preset without exposing instruction bodies', async () => {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  const scope = { id: 'standing' }; const signal = new AbortController().signal
  const summary = { name:'demo',source:'user-agents',provider:'filesystem',path:'/agents/demo/SKILL.md',description:'Demo',invocation:{ modelInvocable:true,userInvocable:false },content:'private body' }
  const snapshot=vi.fn(async()=>({ complete:true,skills:[summary] }))
  ctx.provide('agentPresets',{ standingKeyFor:async()=>scope } as never);ctx.provide('skills',{ snapshot } as never)
  const catalog=new SessionSkillCatalog(ctx)
  expect(await catalog.profileCatalog(signal)).toEqual({ complete:true,skills:[{ name:'demo',source:'user-agents',path:'/agents/demo/SKILL.md',invocation:summary.invocation }] })
  expect(snapshot).toHaveBeenCalledWith({ scope,signal })
})

it('preserves incomplete provider observations and rejects missing scope or cancellation', async () => {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  const snapshot = vi.fn(async () => ({ complete: false, skills: [] }))
  ctx.provide('skills', { snapshot } as never)
  const catalog = new SessionSkillCatalog(ctx)
  await expect(catalog.profileCatalog(new AbortController().signal)).rejects.toThrow()
  expect(snapshot).not.toHaveBeenCalled()
  ctx.provide('agentPresets', { standingKeyFor: async () => ({ id: 'standing' }) } as never)
  expect(await catalog.profileCatalog(new AbortController().signal)).toEqual({ complete: false, skills: [] })
  snapshot.mockClear()
  await expect(catalog.profileCatalog(AbortSignal.abort())).rejects.toThrow()
  expect(snapshot).not.toHaveBeenCalled()
})
