import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SessionId,
  SessionScopeProviderId,
  SessionScopeReference,
  SessionStore,
  type SessionScopeRef,
} from '@deepseek-ai/dsh-session'

const scope: SessionScopeRef = {
  provider: SessionScopeProviderId('example.scope'),
  ref: SessionScopeReference('opaque:subject:1'),
  schemaVersion: 1,
}

async function setup(): Promise<{ sessions: SessionStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { sessions: ctx.sessions }
}

describe('durable session scope on the 0.1.3 line (REQ-20260907-0021 P5b parity)', () => {
  it('snapshots and freezes provider-neutral scope metadata at create', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('scoped'), { meta: { scope } })
    expect(session.header.scope).toEqual(scope)
    expect(Object.isFrozen(session.header.scope)).toBe(true)
  })

  it('inherits the source scope at fork without retaining a mutable alias', async () => {
    const { sessions } = await setup()
    const source = sessions.create(SessionId('scoped-parent'), { meta: { scope } })
    const child = sessions.fork(source, undefined, SessionId('scoped-child'))
    expect(child.header.scope).toEqual(source.header.scope)
    expect(child.header.scope).not.toBe(source.header.scope)
  })

  it('keeps header scope-free when create metadata omits it', async () => {
    const { sessions } = await setup()
    const session = sessions.create(SessionId('plain'))
    expect(session.header.scope).toBeUndefined()
  })
})
