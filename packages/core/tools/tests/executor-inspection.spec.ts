/** Readonly provider inspection follows the same real scoped selection and unloaded sentinel as dispatch. */
import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutor } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'

it('returns the actual inherited and scoped identity without invoking it, and never bypasses an unloaded scope', async () => {
  const ctx = new Context(), presetKey = {}, agentKey = {}, scopes: { preset?: Scope; agent?: Scope; replacement?: Scope } = {}
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  expect(() => ctx.tools.inspectExecutor()).toThrow('selected tool executor is unavailable')
  const root = new NativeToolExecutor(ctx), described = vi.spyOn(root, 'describe'), executed = vi.spyOn(root, 'execute')
  ctx.tools.setExecutor(root)
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(owner: Context) {
    scopes.preset = createScope(owner, presetKey)
    scopes.agent = createScope(owner, agentKey, { parent: presetKey })
  } })
  const preset = scopes.preset, agent = scopes.agent
  if (!preset || !agent) throw Error('missing real scoped registrations')
  const presetExecutor = new NativeToolExecutor(preset.ctx)
  preset.ctx.tools.setExecutor(presetExecutor)
  expect(ctx.tools.inspectExecutor()).toBe(root)
  expect(ctx.tools.inspectExecutor(agentKey)).toBe(presetExecutor)
  const own = new NativeToolExecutor(agent.ctx)
  agent.ctx.tools.setExecutor(own)
  expectTypeOf(ctx.tools.inspectExecutor(agentKey)).toEqualTypeOf<Readonly<ToolExecutor>>()
  expect(ctx.tools.inspectExecutor(agentKey)).toBe(own)
  expect(ctx.tools.inspectExecutor(presetKey)).toBe(presetExecutor)
  expect(described).not.toHaveBeenCalled()
  expect(executed).not.toHaveBeenCalled()
  await agent.dispose()
  expect(() => ctx.tools.inspectExecutor(agentKey)).toThrow('selected tool executor is unavailable')
  expect(ctx.tools.inspectExecutor(presetKey)).toBe(presetExecutor)
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(owner: Context) {
    scopes.replacement = createScope(owner, agentKey)
  } })
  if (!scopes.replacement) throw Error('missing new owner for the same scope')
  const replacement = new NativeToolExecutor(scopes.replacement.ctx)
  scopes.replacement.ctx.tools.setExecutor(replacement)
  expect(ctx.tools.inspectExecutor(agentKey)).toBe(replacement)
})
