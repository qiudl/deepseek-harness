import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlarkCollaborationTransport } from '../src/index.ts'

const FORMAL_AGENT = '11111111-1111-4111-8111-111111111111'
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222'
const INPUT = 'Review the deployment plan.'

afterEach(() => vi.unstubAllGlobals())

describe('SlarkCollaborationTransport', () => {
  it('claims only the requested formal Agent and sends fenced settlement without leaking tokens into URLs', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      if (url.endsWith('/claim')) return new Response(JSON.stringify({
        success: true,
        data: {
          invocation_id: 'inv-1', project_id: 'project-1', attempt_id: 'attempt-1',
          attempt_fence: 2, lease_token: LEASE_TOKEN,
          envelope: {
            schema_version: 'dsh-slark-agent-invocation/v1',
            target_principal: { kind: 'dsh_agent', id: FORMAL_AGENT },
            project_id: 'project-1', connection_id: 'connection-1', policy_epoch: 3,
            input_text: INPUT,
            payload_digest: createHash('sha256').update(INPUT).digest('hex'),
            channel_id: 'channel-1', thread_id: 'thread-1', source_event_id: 'event-1',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/api/internal/v1/dsh/agent-invocations')) {
        return new Response(JSON.stringify({ success: true, data: {
          invocation_id: 'inv-outbound', state: 'admitted', attempt_fence: 1, duplicate: false,
        } }), { status: 202, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: { outcome: 'ok' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))
    const transport = new SlarkCollaborationTransport({
      gatewayUrl: 'https://slark.example.test', serviceToken: 's'.repeat(32), requestTimeoutMs: 1_000,
    })
    const lease = await transport.claim({ subjectToken: 'subject-secret', workerId: 'cell-1',
      formalAgentId: FORMAL_AGENT, leaseMs: 30_000 })
    expect(lease?.envelope.input_text).toBe(INPUT)
    if (lease === null) throw new Error('expected lease')
    await transport.receipt('subject-secret', lease, 'started')
    await transport.project('subject-secret', lease, 'Approved.')
    await transport.receipt('subject-secret', lease, 'terminal', 'succeeded')
    const outbound = await transport.submit('subject-secret', {
      schema_version: 'dsh-slark-agent-invocation/v1',
      source_principal: { kind: 'dsh_agent', id: FORMAL_AGENT },
    })
    expect(outbound).toEqual({ invocationId: 'inv-outbound', state: 'admitted',
      attemptFence: 1, duplicate: false })

    expect(requests.map(item => item.url)).toEqual([
      'https://slark.example.test/api/internal/v1/dsh/agent-invocations/claim',
      'https://slark.example.test/api/internal/v1/dsh/agent-invocations/inv-1/receipts',
      'https://slark.example.test/api/internal/v1/dsh/agent-invocations/inv-1/thread-projections',
      'https://slark.example.test/api/internal/v1/dsh/agent-invocations/inv-1/receipts',
      'https://slark.example.test/api/internal/v1/dsh/agent-invocations',
    ])
    expect(requests.every(item => !item.url.includes('subject-secret'))).toBe(true)
    expect(requests.every(item => new Headers(item.init.headers).get('x-slark-dsh-subject') === 'subject-secret')).toBe(true)
    const projectionBody = requests[2]?.init.body
    if (typeof projectionBody !== 'string') throw new Error('projection request body is missing')
    expect(JSON.parse(projectionBody)).toMatchObject({
      channel_id: 'channel-1', thread_id: 'thread-1', content: 'Approved.',
    })
    await transport.submit('subject-secret', {
      schema_version: 'dsh-slark-agent-invocation/v1',
      source_principal: { kind: 'human', id: 'user-1' },
    }, 'actor.header.signature')
    const humanBody = requests.at(-1)?.init.body
    if (typeof humanBody !== 'string') throw new Error('human admission request body is missing')
    const parsedHumanBody: unknown = JSON.parse(humanBody)
    expect((parsedHumanBody as Record<string, unknown>).actor_assertion).toBe('actor.header.signature')
  })

  it('rejects a digest mismatch before executing the claimed task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: {
      invocation_id: 'inv-1', project_id: 'project-1', attempt_id: 'attempt-1',
      attempt_fence: 1, lease_token: LEASE_TOKEN,
      envelope: { schema_version: 'dsh-slark-agent-invocation/v1',
        target_principal: { kind: 'dsh_agent', id: FORMAL_AGENT }, project_id: 'project-1',
        connection_id: 'connection-1', policy_epoch: 1, input_text: INPUT,
        payload_digest: 'a'.repeat(64), channel_id: 'channel-1', thread_id: null,
        source_event_id: 'event-1' },
    } }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const transport = new SlarkCollaborationTransport({
      gatewayUrl: 'https://slark.example.test', serviceToken: 's'.repeat(32), requestTimeoutMs: 1_000,
    })
    await expect(transport.claim({ subjectToken: 'subject-secret', workerId: 'cell-1',
      formalAgentId: FORMAL_AGENT, leaseMs: 30_000 })).rejects.toThrow(/envelope is invalid/)
  })
})
