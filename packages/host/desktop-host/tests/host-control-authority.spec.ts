import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
  type HostInspectRequest,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority } from '../src/unix-transport.ts'
import { WindowsHostWorkerBridge } from '../src/windows-host-worker-bridge.ts'

const now = 1_000
const ownerId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3198'
const clientInstanceId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3111'
const hostInstanceId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120'
const processNonce = '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q'

describe('transport-neutral Host control authority', () => {
  it('serves the same inspect and Profile dispatcher without a Unix listener', async () => {
    const keys = generateKeyPairSync('ed25519')
    const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(-32).toString('base64url')
    const registry = new ProfileRegistry({
      root: mkdtempSync(join(tmpdir(), 'dsh-host-authority-')),
      deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => now },
      loadSnapshot: () => undefined,
    })
    const host = new DesktopHost({
      registry, clock: { now: () => now }, runtimeGeneration: 5,
      ensureProfileWorker: async () => undefined,
    })
    const revoke = vi.spyOn(host, 'revokeOwner')
    const authority = new HostControlAuthority({
      identity: {
        hostInstanceId,
        installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121',
        installationPublicKey: publicKey,
        installationPrivateKey: keys.privateKey,
        processNonce,
        executableSignatureDigest: '1'.repeat(64),
        runtimeGeneration: 5,
        schemaGeneration: 1,
      },
      host,
      profilePersistenceGeneration: () => 1,
      now: () => now,
    })
    const lifetime = new AbortController()
    const session = authority.openSession(ownerId, lifetime.signal)
    const inspect: HostInspectRequest = {
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
    const inspection = await session.handleRequest(inspect)
    expect(inspection).toMatchObject({
      type: 'result', method: 'host.inspect', result: { host_instance_id: hostInstanceId },
    })
    const status: HostControlFrame = {
      version: 1,
      type: 'request',
      request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3191' as never,
      method: 'profile.status',
      params: {
        client_instance_id: clientInstanceId as never,
        host_instance_id: hostInstanceId as never,
        process_nonce: processNonce as never,
        jti: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3190' as never,
        issued_at: now,
        expires_at: now + 1_000,
        authority_environment_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181' as never,
        account_binding_handle: 'binding:opaque' as never,
        authority_binding_version: 1,
      },
    }
    await expect(session.handleRequest(status)).resolves.toMatchObject({
      type: 'result', method: 'profile.status', result: { state: 'unbound' },
    })
    lifetime.abort()
    session.close()
    expect(revoke).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith(ownerId)

    const responses: unknown[] = []
    const bridge = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => undefined,
      send: (message) => { responses.push(message) },
      openSession: (connectionId, signal) => authority.openSession(connectionId, signal),
    })
    await bridge.receive({ version: 1, type: 'ready', generation: 7, threadHandle: 91n })
    await bridge.receive({ version: 1, type: 'connected', generation: 7, connectionId: ownerId })
    await bridge.receive({
      version: 1,
      type: 'request',
      generation: 7,
      connectionId: ownerId,
      sequence: 1,
      frame: encodeHostControlFrame(inspect),
    })
    expect(responses).toHaveLength(1)
    expect(decodeHostControlFrame((responses[0] as { frame: string }).frame)).toMatchObject({
      type: 'result', method: 'host.inspect', result: { host_instance_id: hostInstanceId },
    })
    await bridge.receive({
      version: 1, type: 'disconnected', generation: 7, connectionId: ownerId, requestsHandled: 1,
    })
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenLastCalledWith(ownerId)
  })
})
