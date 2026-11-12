import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopHost } from '../src/desktop-host.ts'
import type { ProfileOpenResult } from '../src/types.ts'
import { HostAuthorityError } from '../src/types.ts'
import {
  HostControlAuthority,
  UnixHostClient,
  type HostClientFrameTransport,
} from '../src/unix-transport.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('base64url')
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3188'
const ready = { profileId, bindingGeneration: 2 }
const identity = {
  hostInstanceId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120',
  installationId,
  installationPublicKey: publicKey,
  installationPrivateKey: keys.privateKey,
  processNonce: '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q',
  executableSignatureDigest: '1'.repeat(64),
  runtimeGeneration: 5,
  schemaGeneration: 1,
}
const follow = { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } }
const owners = {
  first: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3001',
  second: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3002',
}

/** One Profile view lease as the Host returns it to a connection. */
function viewLease(viewLeaseId: string, leaseGeneration: number): ProfileOpenResult {
  return { profileId: profileId as ProfileOpenResult['profileId'], viewLeaseId: viewLeaseId as ProfileOpenResult['viewLeaseId'],
    viewActivationHandle: 'activation-handle' as ProfileOpenResult['viewActivationHandle'],
    leaseGeneration, expiresAt: 120_000, runtimeGeneration: 5 }
}
const firstLease = viewLease('018f0f4c-87f8-7e2d-a2f8-7b93d34e3168', 3)
const secondLease = viewLease('018f0f4c-87f8-7e2d-a2f8-7b93d34e3169', 4)

/** A worker stream the test drives one event at a time and observes when it stops. */
function workerStream(signal: AbortSignal, stopped: () => void) {
  const pending: unknown[] = []
  let wake: (() => void) | undefined
  const resume = (): void => {
    const resumePending = wake
    wake = undefined
    resumePending?.()
  }
  signal.addEventListener('abort', resume, { once: true })
  return {
    /** Queue one native event for the next worker read. */
    push(value: unknown): void { pending.push(value); resume() },
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      try {
        for (;;) {
          const next = pending.shift()
          if (next !== undefined) { yield next; continue }
          await new Promise<void>((settle) => { wake = settle })
          signal.throwIfAborted()
        }
      } finally { stopped() }
    },
  }
}

/**
 * Host authority that binds each lease to the connection that received it.
 * A request authorizes only with the lease its own connection was granted, so a rebuilt connection
 * must prove the Profile view again instead of inheriting the closed one.
 */
function leaseHost(held: Map<string, ProfileOpenResult>) {
  const host = {
    supportsOfflineAccountRecovery: () => true,
    bootstrapLocalProfile: vi.fn(async () => ready),
    openLocalProfile: vi.fn(async () => firstLease),
    authorizeExtensionView: vi.fn((input: { viewLeaseId: string; leaseGeneration: number
      runtimeGeneration: number; ownerId: string }) => {
      const granted = held.get(input.ownerId)
      if (!granted || granted.viewLeaseId !== input.viewLeaseId
        || granted.leaseGeneration !== input.leaseGeneration
        || granted.runtimeGeneration !== input.runtimeGeneration) throw new HostAuthorityError('stale')
      return profileId
    }),
    authorizeViewContinuation: vi.fn((input: { profileId: string; runtimeGeneration: number
      ownerId: string }) => {
      const granted = held.get(input.ownerId)
      if (!granted || granted.profileId !== input.profileId
        || granted.runtimeGeneration !== input.runtimeGeneration) throw new HostAuthorityError('stale')
      return profileId
    }),
    activateView: vi.fn(async () => ({ origin: 'http://127.0.0.1:43125', activationGeneration: 1,
      expiresAt: 120_000, bootstrapCookie: { name: 'fixture', value: 'private' } })),
    closeOwnedViewLease: vi.fn(),
    revokeOwner: vi.fn(),
  }
  return { host: host as unknown as DesktopHost, bindings: host }
}

function clientAuthorization(client: UnixHostClient): Record<string, unknown> {
  const auth: unknown = Reflect.get(client, 'auth')
  if (typeof auth !== 'function') throw new Error('missing test client authorization')
  const value: unknown = Reflect.apply(auth, client, [])
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid test client authorization')
  }
  return value as Record<string, unknown>
}

interface Connection {
  readonly client: UnixHostClient
  readonly lifetime: AbortController
  readonly session: ReturnType<HostControlAuthority['openSession']>
}

/** Open one authenticated control connection with its own owner identity. */
async function connect(authority: HostControlAuthority, ownerId: string): Promise<Connection> {
  const lifetime = new AbortController()
  const session = authority.openSession(ownerId, lifetime.signal)
  const transport: HostClientFrameTransport = {
    call: async (frame) => await session.handleRequest(frame),
    isConnected: () => !lifetime.signal.aborted,
    close: () => { lifetime.abort(); session.close() },
  }
  const client = await UnixHostClient.connectAuthenticatedTransport({
    trustedInstallationId: installationId,
    trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    now: () => 1_000,
  }, transport)
  return { client, lifetime, session }
}

describe('remote UI stream continuity', () => {
  it('continues one Profile cursor on the connection that re-established the view', async () => {
    const held = new Map<string, ProfileOpenResult>()
    const { host, bindings } = leaseHost(held)
    const stopped = vi.fn()
    const diagnostics = { record: vi.fn() }
    const authority = new HostControlAuthority({ identity, host, now: () => 1_000,
      profilePersistenceGeneration: () => 3, diagnostics,
      remoteUiStream: (_profile, _endpoint, _payload, signal) => workerStream(signal, stopped) })
    onTestFinished(() => { void authority.close() })

    bindings.openLocalProfile.mockResolvedValueOnce(firstLease).mockResolvedValueOnce(secondLease)
    const first = await connect(authority, owners.first)
    const firstOpened = await first.client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })
    const firstView = await first.client.openLocalProfile({ profileSelector: firstOpened.profileSelector })
    held.set(owners.first, firstView)
    const stream_id = randomUUID()
    await expect(first.client.remoteUiStream({ ...firstView, command: {
      action: 'open', stream_id, endpoint: 'session/follow', payload: follow } })).resolves.toEqual({ type: 'opened' })
    await expect(first.client.remoteUiStream({ ...firstView, command: { action: 'poll', stream_id } }))
      .resolves.toEqual({ type: 'idle' })

    // The desktop view is re-established on a new connection; the old connection and lease end.
    first.lifetime.abort()
    first.session.close()
    held.delete(owners.first)

    const second = await connect(authority, owners.second)
    const secondOpened = await second.client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })
    const secondView = await second.client.openLocalProfile({ profileSelector: secondOpened.profileSelector })
    held.set(owners.second, secondView)
    expect(secondView.viewLeaseId).not.toEqual(firstView.viewLeaseId)

    // The client keeps addressing the cursor with the coordinates it received at open.
    await expect(second.client.remoteUiStream({ ...firstView, command: { action: 'poll', stream_id } }))
      .resolves.toEqual({ type: 'idle' })
    await expect(second.client.remoteUiStream({ ...firstView, command: { action: 'close', stream_id } }))
      .resolves.toEqual({ type: 'closed' })
    expect(stopped).toHaveBeenCalledOnce()
    expect(bindings.authorizeViewContinuation).toHaveBeenCalledWith({
      profileId, runtimeGeneration: 5, ownerId: owners.second })
    expect(diagnostics.record).not.toHaveBeenCalled()
    second.client.close()
  })

  it('releases a cursor whose resuming connection holds no view lease', async () => {
    const held = new Map<string, ProfileOpenResult>()
    const { host, bindings } = leaseHost(held)
    const stopped = vi.fn()
    const diagnostics = { record: vi.fn() }
    const authority = new HostControlAuthority({ identity, host, now: () => 1_000,
      profilePersistenceGeneration: () => 3, diagnostics,
      remoteUiStream: (_profile, _endpoint, _payload, signal) => workerStream(signal, stopped) })
    onTestFinished(() => { void authority.close() })

    bindings.openLocalProfile.mockResolvedValueOnce(firstLease)
    const first = await connect(authority, owners.first)
    const opened = await first.client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })
    const view = await first.client.openLocalProfile({ profileSelector: opened.profileSelector })
    held.set(owners.first, view)
    const stream_id = randomUUID()
    await expect(first.client.remoteUiStream({ ...view, command: {
      action: 'open', stream_id, endpoint: 'session/follow', payload: follow } })).resolves.toEqual({ type: 'opened' })

    held.clear()
    first.lifetime.abort()
    first.session.close()
    const second = await connect(authority, owners.second)
    await expect(second.client.remoteUiStream({ ...view, command: { action: 'poll', stream_id } }))
      .rejects.toMatchObject({ code: 'stale' })
    await vi.waitFor(() => { expect(stopped).toHaveBeenCalledOnce() })
    expect(diagnostics.record).toHaveBeenCalledWith(
      { event: 'control-session', reason: 'cursor_lease', method: 'profile.remote_ui_stream' })
    await expect(second.client.remoteUiStream({ ...view, command: { action: 'poll', stream_id } }))
      .rejects.toMatchObject({ code: 'stale' })
    expect(diagnostics.record).toHaveBeenLastCalledWith(
      { event: 'control-session', reason: 'cursor_absent', method: 'profile.remote_ui_stream' })
    second.client.close()
  })

  it('releases a cursor addressed with replaced coordinates', async () => {
    const held = new Map<string, ProfileOpenResult>()
    const { host, bindings } = leaseHost(held)
    const stopped = vi.fn()
    const diagnostics = { record: vi.fn() }
    const authority = new HostControlAuthority({ identity, host, now: () => 1_000,
      profilePersistenceGeneration: () => 3, diagnostics,
      remoteUiStream: (_profile, _endpoint, _payload, signal) => workerStream(signal, stopped) })
    onTestFinished(() => { void authority.close() })

    bindings.openLocalProfile.mockResolvedValueOnce(firstLease)
    const connection = await connect(authority, owners.first)
    const opened = await connection.client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })
    const view = await connection.client.openLocalProfile({ profileSelector: opened.profileSelector })
    held.set(owners.first, view)
    const stream_id = randomUUID()
    await expect(connection.client.remoteUiStream({ ...view, command: {
      action: 'open', stream_id, endpoint: 'session/follow', payload: follow } })).resolves.toEqual({ type: 'opened' })

    const response = await connection.session.handleRequest({
      version: 1, type: 'request', request_id: randomUUID(), method: 'profile.remote_ui_stream',
      params: { ...clientAuthorization(connection.client), view_lease_id: view.viewLeaseId,
        lease_generation: view.leaseGeneration + 1, runtime_generation: view.runtimeGeneration,
        command: { action: 'poll', stream_id } },
    } as never)
    expect(response).toMatchObject({ type: 'error', error: { code: 'stale' } })
    await vi.waitFor(() => { expect(stopped).toHaveBeenCalledOnce() })
    expect(diagnostics.record).toHaveBeenCalledWith(
      { event: 'control-session', reason: 'cursor_replaced', method: 'profile.remote_ui_stream' })
    connection.client.close()
  })

  it('releases cursors whose resumability window elapsed', async () => {
    const held = new Map<string, ProfileOpenResult>()
    const { host, bindings } = leaseHost(held)
    const stopped = vi.fn()
    let now = 1_000
    const authority = new HostControlAuthority({ identity, host, now: () => now,
      profilePersistenceGeneration: () => 3, remoteUiStreamOrphanGraceMs: 1_000,
      remoteUiStream: (_profile, _endpoint, _payload, signal) => workerStream(signal, stopped) })
    onTestFinished(() => { void authority.close() })

    bindings.openLocalProfile.mockResolvedValueOnce(firstLease).mockResolvedValueOnce(secondLease)
    const first = await connect(authority, owners.first)
    const opened = await first.client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })
    const view = await first.client.openLocalProfile({ profileSelector: opened.profileSelector })
    held.set(owners.first, view)
    for (let index = 0; index < 8; index += 1) {
      await expect(first.client.remoteUiStream({ ...view, command: { action: 'open',
        stream_id: randomUUID(), endpoint: 'session/follow', payload: follow } })).resolves.toEqual({ type: 'opened' })
    }
    first.lifetime.abort()
    first.session.close()

    now += 1_000
    const second = await connect(authority, owners.second)
    const reopened = await second.client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })
    const nextView = await second.client.openLocalProfile({ profileSelector: reopened.profileSelector })
    held.set(owners.second, nextView)
    // The elapsed window releases every orphan before the Profile accepts another cursor.
    await expect(second.client.remoteUiStream({ ...nextView, command: { action: 'open',
      stream_id: randomUUID(), endpoint: 'session/follow', payload: follow } })).resolves.toEqual({ type: 'opened' })
    expect(stopped).toHaveBeenCalledTimes(8)
    second.client.close()
  })

  it('keeps one Profile within eight cursors across its connections', async () => {
    const held = new Map<string, ProfileOpenResult>()
    const { host, bindings } = leaseHost(held)
    const authority = new HostControlAuthority({ identity, host, now: () => 1_000,
      profilePersistenceGeneration: () => 3,
      remoteUiStream: (_profile, _endpoint, _payload, signal) => workerStream(signal, () => undefined) })
    onTestFinished(() => { void authority.close() })

    bindings.openLocalProfile.mockResolvedValueOnce(firstLease)
    const connection = await connect(authority, owners.first)
    const opened = await connection.client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })
    const view = await connection.client.openLocalProfile({ profileSelector: opened.profileSelector })
    held.set(owners.first, view)
    const open = () => connection.client.remoteUiStream({ ...view, command: { action: 'open',
      stream_id: randomUUID(), endpoint: 'session/follow', payload: follow } })
    for (let index = 0; index < 8; index += 1) await expect(open()).resolves.toEqual({ type: 'opened' })
    await expect(open()).rejects.toMatchObject({ code: 'conflict' })
    connection.client.close()
  })
})
