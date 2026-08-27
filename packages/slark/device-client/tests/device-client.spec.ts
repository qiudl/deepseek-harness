import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SlarkDeviceClient, {
  SlarkDeviceClientError,
  type SlarkDeviceAuthority,
} from '../src/index.ts'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const GRANT_ID = '22222222-2222-4222-8222-222222222222'
const authority: SlarkDeviceAuthority = {
  subjectToken: 'subject-token',
  sessionId: 'session-1',
  computerId: 'computer-1',
  workspaceHandle: 'workspace-1',
  grantId: GRANT_ID,
  grantEpoch: 3,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function taskResult(value: unknown): { bytes: Uint8Array; digest: string } {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
}

function completed(value: unknown) {
  const result = taskResult(value)
  return {
    success: true,
    message: 'ok',
    data: {
      task_id: TASK_ID,
      state: 'completed',
      state_version: 3,
      authority_version: 7,
      result_digest: result.digest,
      terminal_code: null,
      created_at: '2030-03-17T17:46:40.000Z',
      expires_at: '2030-03-17T17:47:40.000Z',
      terminal_at: '2030-03-17T17:46:41.000Z',
      receipts: [],
      output: [{
        output_seq: 1,
        stream: 'stdout',
        byte_offset: 0,
        chunk_bytes: result.bytes.byteLength,
        chunk_digest: result.digest,
        ciphertext: Buffer.from(result.bytes).toString('base64'),
        truncated_before: false,
      }],
      next_event_seq: 0,
      next_output_seq: 1,
      output_complete: true,
      output_gap: false,
      available_from_seq: 1,
    },
  }
}

async function setup(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock)
  const ctx = new Context()
  await ctx.plugin(SlarkDeviceClient, {
    gatewayUrl: 'https://slark.internal',
    serviceToken: 'service-token-1234',
    requestTimeoutMs: 1_000,
    longPollMs: 10,
    taskTtlMs: 60_000,
    maxPageBytes: 262_144,
    maxResultBytes: 786_432,
    createAttempts: 2,
  })
  const client = ctx.slarkDevice
  const disposeAuthority = client.bindAuthority(async () => authority)
  return { ctx, client, disposeAuthority }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SlarkDeviceClient', () => {
  it('retries an ambiguous create with the same identity and polls the original task', async () => {
    const result = {
      protocolVersion: 1,
      kind: 'dsh-fs-result-v1',
      operation: 'stat',
      ok: true,
      result: { info: null },
    }
    const requests: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = []
    let createCalls = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (init?.body !== undefined && typeof init.body !== 'string') throw new TypeError('expected JSON body')
      const body = init?.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>
      requests.push({ url, init: init ?? {}, ...(body === undefined ? {} : { body }) })
      if (url.endsWith('/api/internal/v1/dsh/device-tasks')) {
        createCalls += 1
        if (createCalls === 1) throw new TypeError('connection reset after write')
        return json({
          success: true,
          message: 'ok',
          data: {
            task_id: TASK_ID,
            state: 'queued',
            state_version: 1,
            status_url: `/api/internal/v1/dsh/device-tasks/${TASK_ID}`,
          },
        }, 202)
      }
      return json(completed(result))
    })
    const { ctx, client } = await setup(fetchMock)

    const execution = await client.executeTask({
      expectedWorkspaceHandle: 'workspace-1',
      capability: 'fs_read',
      operation: 'stat',
      payload: { path: 'README.md' },
    })

    expect(JSON.parse(new TextDecoder().decode(execution.result))).toEqual(result)
    const creates = requests.filter(request => request.url.endsWith('/device-tasks'))
    expect(creates).toHaveLength(2)
    expect(creates[0]?.body?.idempotency_key).toBe(creates[1]?.body?.idempotency_key)
    expect(creates[0]?.body?.payload_digest).toBe(creates[1]?.body?.payload_digest)
    const query = requests.at(-1)
    expect(query?.url).not.toContain('subject-token')
    expect(new Headers(query?.init.headers).get('x-slark-dsh-subject')).toBe('subject-token')
    expect(new Headers(query?.init.headers).get('authorization')).toBe('Bearer service-token-1234')
    await ctx.fiber.dispose()
  })

  it('cancels a known task when the caller aborts and never creates a replacement task', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init: init ?? {} })
      if (url.endsWith('/device-tasks')) {
        return json({ success: true, message: 'ok', data: {
          task_id: TASK_ID,
          state: 'queued',
          state_version: 1,
          status_url: `/api/internal/v1/dsh/device-tasks/${TASK_ID}`,
        } }, 202)
      }
      if (url.endsWith('/cancel')) {
        return json({ success: true, message: 'ok', data: completed({}).data })
      }
      controller.abort('stop')
      return json({ success: true, message: 'ok', data: {
        ...completed({}).data,
        state: 'running',
        state_version: 2,
        result_digest: null,
        terminal_at: null,
        output: [],
        output_complete: false,
        next_output_seq: 0,
      } })
    })
    const { ctx, client } = await setup(fetchMock)

    await expect(client.executeTask({
      expectedWorkspaceHandle: 'workspace-1',
      capability: 'fs_read',
      operation: 'read',
      payload: { path: 'README.md' },
    }, controller.signal)).rejects.toMatchObject({ code: 'request_aborted' })

    expect(calls.filter(call => call.url.endsWith('/device-tasks'))).toHaveLength(1)
    expect(calls.some(call => call.url.endsWith(`/${TASK_ID}/cancel`))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('fails closed for output gaps, digest mismatches, workspace changes, and missing identity', async () => {
    const fsResult = {
      protocolVersion: 1,
      kind: 'dsh-fs-result-v1',
      operation: 'stat',
      ok: true,
      result: { info: null },
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ success: true, message: 'ok', data: {
        task_id: TASK_ID,
        state: 'queued',
        state_version: 1,
        status_url: `/api/internal/v1/dsh/device-tasks/${TASK_ID}`,
      } }, 202))
      .mockResolvedValueOnce(json({
        ...completed(fsResult),
        data: { ...completed(fsResult).data, output_gap: true, available_from_seq: 4 },
      }))
    const { ctx, client, disposeAuthority } = await setup(fetchMock)

    await expect(client.executeTask({
      expectedWorkspaceHandle: 'workspace-1',
      capability: 'fs_read',
      operation: 'stat',
      payload: { path: '.' },
    })).rejects.toMatchObject({ code: 'output_gap' })

    await expect(client.executeTask({
      expectedWorkspaceHandle: 'other-workspace',
      capability: 'fs_read',
      operation: 'stat',
      payload: { path: '.' },
    })).rejects.toMatchObject({ code: 'workspace_changed' })

    await disposeAuthority()
    await expect(client.executeTask({
      expectedWorkspaceHandle: 'workspace-1',
      capability: 'fs_read',
      operation: 'stat',
      payload: { path: '.' },
    })).rejects.toBeInstanceOf(SlarkDeviceClientError)
    await expect(client.executeTask({
      expectedWorkspaceHandle: 'workspace-1',
      capability: 'fs_read',
      operation: 'stat',
      payload: { path: '.' },
    })).rejects.toMatchObject({ code: 'identity_unavailable' })
    await ctx.fiber.dispose()
  })
})
