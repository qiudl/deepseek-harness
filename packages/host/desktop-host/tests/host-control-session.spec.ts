import type {
  HostControlFrame,
  HostInspectRequest,
  HostInspectResult,
} from '@deepseek-ai/dsh-host-control-protocol'
import { decodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  HostControlServerSession,
  type HostControlServerSessionOptions,
} from '../src/host-control-session.ts'
import { HostAuthorityError } from '../src/types.ts'
import type { WindowsHostWorkerSession } from '../src/windows-host-worker-bridge.ts'

const clientInstanceId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3111'
const hostInstanceId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120'
const processNonce = '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q'

function inspectRequest(): HostInspectRequest {
  return {
    version: 1,
    type: 'request',
    request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3123' as never,
    method: 'host.inspect',
    params: {
      challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never,
      client_instance_id: clientInstanceId as never,
      supported_versions: [1],
    },
  }
}

function inspectResult(request: HostInspectRequest): HostInspectResult {
  const result = decodeHostControlFrame(`${JSON.stringify({
    version: 1,
    type: 'result',
    request_id: request.request_id,
    method: request.method,
    result: {
      protocol_version: 1,
      host_instance_id: hostInstanceId as never,
      installation_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121' as never,
      installation_public_key: 'A'.repeat(43) as never,
      runtime_generation: 5,
      schema_generation: 1,
      process_nonce: processNonce as never,
      capabilities: ['host.inspect', 'profile.status'],
      challenge_signature: 'A'.repeat(86) as never,
      executable_signature_digest: '1'.repeat(64) as never,
    },
  })}\n`)
  if (result.type !== 'result' || result.method !== 'host.inspect') throw new Error('Invalid inspect fixture')
  return result
}

function statusRequest(jti = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3190'): HostControlFrame {
  return {
    version: 1,
    type: 'request',
    request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3191' as never,
    method: 'profile.status',
    params: {
      client_instance_id: clientInstanceId as never,
      host_instance_id: hostInstanceId as never,
      process_nonce: processNonce as never,
      jti: jti as never,
      issued_at: 1_000,
      expires_at: 2_000,
      authority_environment_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181' as never,
      account_binding_handle: 'binding:opaque' as never,
      authority_binding_version: 1,
    },
  }
}

function fixture(signal?: AbortSignal) {
  const revokeOwner = vi.fn()
  const dispatch = vi.fn<HostControlServerSessionOptions['dispatchAuthorized']>(async (request, context, respond) => {
    expect(context.ownerId).toBe('connection-1')
    expect(context.signal.aborted).toBe(false)
    respond({
      version: 1,
      type: 'result',
      request_id: request.request_id,
      method: request.method,
      result: { state: 'unbound' },
    } as HostControlFrame)
  })
  const session = new HostControlServerSession({
    ownerId: 'connection-1',
    now: () => 1_000,
    ...(signal ? { signal } : {}),
    inspect: request => inspectResult(request),
    dispatchAuthorized: dispatch,
    errorResponse: request => decodeHostControlFrame(`${JSON.stringify({
      version: 1,
      type: 'error',
      request_id: request.request_id,
      method: request.method,
      error: {
        code: 'internal_error',
        retryable: false,
        correlation_id: request.request_id,
      },
    })}\n`),
    revokeOwner,
  })
  const workerSession: WindowsHostWorkerSession = session
  return { session: workerSession, dispatch, revokeOwner }
}

describe('Host control server session', () => {
  it('shares inspect and authorized request handling with the Windows Worker session interface', async () => {
    const { session, dispatch } = fixture()
    const inspection = inspectRequest()
    await expect(session.handleRequest(inspection, new AbortController().signal))
      .resolves.toEqual(inspectResult(inspection))
    await expect(session.handleRequest(statusRequest(), new AbortController().signal))
      .resolves.toMatchObject({ type: 'result', method: 'profile.status', result: { state: 'unbound' } })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('rejects requests before inspect, a second inspect, and replayed authorization', async () => {
    const before = fixture()
    await expect(before.session.handleRequest(statusRequest(), new AbortController().signal))
      .rejects.toBeInstanceOf(HostAuthorityError)

    const active = fixture()
    const inspection = inspectRequest()
    await active.session.handleRequest(inspection, new AbortController().signal)
    await expect(active.session.handleRequest(inspection, new AbortController().signal))
      .rejects.toBeInstanceOf(HostAuthorityError)
    await active.session.handleRequest(statusRequest(), new AbortController().signal)
    await expect(active.session.handleRequest(statusRequest(), new AbortController().signal))
      .resolves.toMatchObject({ type: 'error', method: 'profile.status' })
    expect(active.dispatch).toHaveBeenCalledOnce()
  })

  it('aborts owned work and revokes the connection exactly once', async () => {
    const lifetime = new AbortController()
    const { session, revokeOwner } = fixture(lifetime.signal)
    lifetime.abort()
    await Promise.resolve()
    expect(revokeOwner).toHaveBeenCalledOnce()
    await session.close()
    expect(revokeOwner).toHaveBeenCalledOnce()
    await expect(session.handleRequest(inspectRequest(), new AbortController().signal))
      .rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('fails closed instead of normalizing an uncorrelated dispatcher response', async () => {
    const errorResponse = vi.fn<HostControlServerSessionOptions['errorResponse']>(request => decodeHostControlFrame(`${JSON.stringify({
      version: 1,
      type: 'error',
      request_id: request.request_id,
      method: request.method,
      error: { code: 'internal_error', retryable: false, correlation_id: request.request_id },
    })}\n`))
    const session = new HostControlServerSession({
      ownerId: 'connection-1',
      now: () => 1_000,
      inspect: request => inspectResult(request),
      dispatchAuthorized: (request, _context, respond) => {
        respond({
          version: 1,
          type: 'result',
          request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3199' as never,
          method: request.method,
          result: { state: 'unbound' },
        } as HostControlFrame)
      },
      errorResponse,
      revokeOwner: () => undefined,
    })
    await session.handleRequest(inspectRequest())
    await expect(session.handleRequest(statusRequest())).rejects.toBeInstanceOf(HostAuthorityError)
    expect(errorResponse).not.toHaveBeenCalled()
  })
})
