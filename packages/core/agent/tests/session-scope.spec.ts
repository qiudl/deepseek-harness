import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionScopeProviderId, SessionScopeReference, type SessionScopeRef } from '@deepseek-ai/dsh-session'
import AgentRegistry from '../src/index.ts'

describe('session scope providers (REQ-20260907-0021 fork overlay)', () => {
  const scope: SessionScopeRef = {
    provider: SessionScopeProviderId('example.scope'),
    ref: SessionScopeReference('opaque:subject:1'),
    schemaVersion: 1,
  }

  it('registers one exact provider and admits its opaque reference', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const admitted: unknown[] = []
    const dispose = ctx.agents.registerScopeProvider(scope.provider, {
      admit: value => void admitted.push(value),
    })

    await ctx.agents.admitSessionScope(scope, ctx, new AbortController().signal)

    expect(admitted).toEqual([scope])
    expect(() => ctx.agents.registerScopeProvider(scope.provider, { admit() {} }))
      .toThrow(/already registered/)
    dispose()
    await expect(ctx.agents.admitSessionScope(scope, ctx, new AbortController().signal))
      .rejects.toThrow(/is not registered/)
  })

  it('fails admission when the provider unloads while its check is pending', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const gate = Promise.withResolvers<undefined>()
    const dispose = ctx.agents.registerScopeProvider(scope.provider, { admit: () => gate.promise })

    const admission = ctx.agents.admitSessionScope(scope, ctx, new AbortController().signal)
    dispose()
    gate.resolve(undefined)

    await expect(admission).rejects.toThrow(/was disposed during admission/)
  })

  it('is a no-op when the session carries no scope', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await expect(
      ctx.agents.admitSessionScope(undefined, ctx, new AbortController().signal),
    ).resolves.toBeUndefined()
  })
})
