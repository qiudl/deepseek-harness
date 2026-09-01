import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SlarkCollaborationNetwork from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Slark collaboration through a real Loader composition', () => {
  it('loads as an ordinary Cordis service with the worker disabled', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-slark-collaboration-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-slark-collaboration-network'",
      '  config:',
      '    enabled: false',
      "    gatewayUrl: 'https://slark.example.test'",
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "    workspaceHandle: 'workspace-1'",
      "    workerId: 'cell-1'",
      '    formalAgents: []',
      '',
    ].join('\n'))
    const ctx = new Context()
    context = ctx
    ctx.provide('agents', {} as never)
    ctx.provide('agentPresets', {} as never)
    ctx.provide('slarkIdentity', {} as never)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-slark-collaboration-network') {
          throw new Error(`unexpected Loader import: ${specifier}`)
        }
        return SlarkCollaborationNetwork
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
    expect(ctx.get('slarkCollaborationNetwork')).toBeInstanceOf(SlarkCollaborationNetwork)
  })

  it('starts and drains an enabled owner-scoped worker through Cordis lifecycle', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-slark-collaboration-active-'))
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url)
      if (url.endsWith('/api/internal/v1/dsh/agent-invocations')) {
        return new Response(JSON.stringify({ success: true, data: {
          invocation_id: 'inv-outbound', state: 'admitted', attempt_fence: 1, duplicate: false,
        } }), { status: 202, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 204 })
    }))
    const ctx = new Context()
    context = ctx
    ctx.provide('agents', {} as never)
    ctx.provide('agentPresets', {} as never)
    ctx.provide('slarkIdentity', {
      authorityForSession: async () => ({ subjectToken: 'subject-token' }),
    } as never)
    const fiber = ctx.plugin(SlarkCollaborationNetwork, {
      enabled: true,
      gatewayUrl: 'https://slark.example.test',
      serviceToken: 's'.repeat(32),
      workspaceRoot: root,
      workspaceHandle: 'workspace-1',
      workerId: 'cell-1',
      formalAgents: [{
        formalAgentId: '11111111-1111-4111-8111-111111111111',
        presetRef: 'reviewer',
      }],
      pollIntervalMs: 100,
      leaseMs: 30_000,
      requestTimeoutMs: 1_000,
    })
    await fiber.await()
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    const outbound = await ctx.slarkCollaborationNetwork.dispatch(
      '11111111-1111-4111-8111-111111111111',
      { schema_version: 'dsh-slark-agent-invocation/v1',
        source_principal: { kind: 'dsh_agent', id: '11111111-1111-4111-8111-111111111111' } },
    )
    expect(outbound.invocationId).toBe('inv-outbound')
    const humanOutbound = await ctx.slarkCollaborationNetwork.dispatchHuman('session-1', {
      schema_version: 'dsh-slark-agent-invocation/v1',
      source_principal: { kind: 'human', id: 'user-1' },
    }, 'actor.header.signature')
    expect(humanOutbound.invocationId).toBe('inv-outbound')
    await fiber.dispose()
    expect(requests[0]).toBe('https://slark.example.test/api/internal/v1/dsh/agent-invocations/claim')
    expect(requests[1]).toBe('https://slark.example.test/api/internal/v1/dsh/agent-invocations')
    expect(requests[2]).toBe('https://slark.example.test/api/internal/v1/dsh/agent-invocations')
  })
})
