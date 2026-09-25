import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type {
  HostControlCapability,
  HostExtensionKind,
  HostRemoteSessionCommand,
  ProfileEnsureRequest,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopHost } from '../src/desktop-host.ts'
import type { ProfileExtensionOperations } from '../src/extension-operations.ts'
import { HostAuthorityError } from '../src/types.ts'
import {
  HostControlAuthority,
  UnixHostClient,
  type HostClientFrameTransport,
  type MigrationExportService,
  type MigrationImportService,
  type UnixHostServerOptions,
} from '../src/unix-transport.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('base64url')
const ownerId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3198'
const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3188'
const operationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3178'
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
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
const ready = { profileId, bindingGeneration: 2 }
const opened = { profileId, viewLeaseId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3168',
  viewActivationHandle: 'activation-handle', leaseGeneration: 3, expiresAt: 20_000, runtimeGeneration: 5 }
const proof = { inventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1', schemaVersion: 1,
  requiredMaxRecords: 8, requiredMaxBytes: 4_096 }
const receipt = { exportId: 'export-1', transferId: randomUUID(), transferDigest: '3'.repeat(64), schemaVersion: 1,
  sourceGeneration: 'generation-1', recordCount: 1, firstEventSequence: 1, lastEventSequence: 1,
  semanticDigest: '4'.repeat(64), chunkCount: 1 }
const chunk = { exportId: 'export-1', chunkIndex: 0, records: [
  { collection: 'sessions' as const, id: 'session-1', sequence: 0, payloadDigest: '5'.repeat(64) },
  { collection: 'session_events' as const, id: 'event-1', sessionId: 'session-1', sequence: 1,
    payloadDigest: '6'.repeat(64) },
], chunkDigest: '7'.repeat(64), final: true }

function fakeHost(): DesktopHost {
  return {
    supportsOfflineAccountRecovery: () => true,
    bootstrapLocalProfile: vi.fn(async () => ready),
    restoreLocalProfile: vi.fn(async () => ready),
    ensureAccountProfile: vi.fn(async () => ready),
    restoreProfile: vi.fn(async () => ready),
    getProfileStatus: vi.fn(() => ({ state: 'ready', profileId })),
    openProfile: vi.fn(async () => opened),
    openLocalProfile: vi.fn(async () => opened),
    inspectOfflineAccountProfiles: vi.fn(async () => ({ candidates: [] })),
    recoverOfflineAccountProfile: vi.fn(async () => ({ ...ready, persistenceGeneration: 3, runtimeGeneration: 5 })),
    openOfflineAccountProfile: vi.fn(async () => opened),
    getOfflineAccountRecoveryStatus: vi.fn(() => ({ state: 'recovering' })),
    authorizeMigrationProfileSelector: vi.fn((input: { profileId: string }) => input.profileId),
    authorizeExtensionView: vi.fn(() => profileId),
    activateView: vi.fn(async () => ({ origin: 'http://127.0.0.1:43125', activationGeneration: 1,
      expiresAt: 20_000, bootstrapCookie: { name: 'fixture', value: 'private' } })),
    closeOwnedViewLease: vi.fn(),
    revokeOwner: vi.fn(),
  } as unknown as DesktopHost
}

async function authorityClient(options: Partial<UnixHostServerOptions> = {}): Promise<{
  client: UnixHostClient
  lifetime: AbortController
  host: DesktopHost
  session: ReturnType<HostControlAuthority['openSession']>
  transport: HostClientFrameTransport
}> {
  const host = options.host ?? fakeHost()
  const authority = new HostControlAuthority({
    identity,
    host,
    profilePersistenceGeneration: () => 3,
    now: () => 1_000,
    ...options,
  })
  const lifetime = new AbortController()
  const session = authority.openSession(ownerId, lifetime.signal)
  const transport: HostClientFrameTransport = {
    call: frame => session.handleRequest(frame),
    isConnected: () => !lifetime.signal.aborted,
    close: () => { lifetime.abort(); session.close() },
  }
  const client = await UnixHostClient.connectAuthenticatedTransport({
    trustedInstallationId: installationId,
    trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    now: () => 1_000,
  }, transport)
  return { client, lifetime, host, session, transport }
}

async function localSelector(client: UnixHostClient): Promise<string> {
  return (await client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })).profileSelector
}

describe('Unix transport authority failures', () => {
  it('advertises and executes remote session commands only through a live owned view lease', async () => {
    const command: HostRemoteSessionCommand = {
      operation: 'session.list', command_id: randomUUID() as never,
    }
    const unavailable = await authorityClient()
    expect(unavailable.client.inspection.capabilities).not.toContain('profile.remote_session')
    await expect(unavailable.client.remoteSession({ ...opened, command }))
      .rejects.toMatchObject({ code: 'upgrade_required' })
    unavailable.client.close()

    const host = fakeHost()
    const remoteSession = vi.fn(async (resolvedProfileId: string, received: HostRemoteSessionCommand,
      signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      return { profile_id: resolvedProfileId, operation: received.operation }
    })
    const { client } = await authorityClient({ host, remoteSession })
    expect(client.inspection.capabilities).toContain('profile.remote_session')
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteSession({ ...lease, command })).resolves.toEqual({
      profile_id: profileId, operation: 'session.list',
    })
    expect(vi.mocked(host).authorizeExtensionView.mock.calls).toHaveLength(2)
    expect(remoteSession).toHaveBeenCalledWith(profileId, command, expect.any(AbortSignal))
    client.close()
  })

  it('rechecks the remote session lease after awaited execution', async () => {
    const host = fakeHost()
    vi.mocked(host).authorizeExtensionView
      .mockReturnValueOnce(profileId as never)
      .mockImplementationOnce(() => { throw new HostAuthorityError('stale') })
    const { client } = await authorityClient({
      host,
      remoteSession: async () => ({ items: [] }),
    })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteSession({
      ...lease,
      command: { operation: 'session.list', command_id: randomUUID() as never },
    })).rejects.toMatchObject({ code: 'stale' })
    client.close()
  })

  it('rejects an unbounded remote session executor result before transport', async () => {
    const { client } = await authorityClient({
      remoteSession: async () => ({ invalid: Number.NaN }),
    })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteSession({
      ...lease,
      command: { operation: 'session.list', command_id: randomUUID() as never },
    })).rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('rejects unadvertised remote methods even when a client sends a forged control request', async () => {
    const { client, session } = await authorityClient()
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    const auth = () => (client as unknown as { auth(): Record<string, unknown> }).auth()
    const common = () => ({ ...auth(), view_lease_id: lease.viewLeaseId as never,
      lease_generation: lease.leaseGeneration, runtime_generation: lease.runtimeGeneration })
    const sessionResult = await session.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
      method: 'profile.remote_session', params: { ...common(),
        command: { operation: 'session.list', command_id: randomUUID() as never } } } as never)
    expect(sessionResult).toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
    const readResult = await session.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
      method: 'profile.remote_ui_read', params: { ...common(),
        endpoint: 'session/list', payload: { args: {} } } } as never)
    expect(readResult).toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
    client.close()
  })

  it('keeps remote UI reads disabled without an executor and binds them to a live view lease', async () => {
    const input = { ...opened, endpoint: 'session/list' as const, payload: { args: { _request: {} } } }
    const unavailable = await authorityClient()
    expect(unavailable.client.inspection.capabilities).not.toContain('profile.remote_ui_read')
    await expect(unavailable.client.remoteUiRead(input)).rejects.toMatchObject({ code: 'upgrade_required' })
    unavailable.client.close()

    const host = fakeHost()
    const remoteUiRead = vi.fn(async () => ({ sessions: [] }))
    const { client } = await authorityClient({ host, remoteUiRead })
    expect(client.inspection.capabilities).toContain('profile.remote_ui_read')
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteUiRead({ ...lease, endpoint: input.endpoint, payload: input.payload }))
      .resolves.toEqual({ sessions: [] })
    expect(vi.mocked(host).authorizeExtensionView.mock.calls).toHaveLength(2)
    expect(remoteUiRead).toHaveBeenCalledWith(profileId, input.endpoint, input.payload, expect.any(AbortSignal))
    client.close()
  })

  it('drops a remote UI response when the lease is revoked during worker execution', async () => {
    const host = fakeHost()
    vi.mocked(host).authorizeExtensionView.mockReturnValueOnce(profileId as never)
      .mockImplementationOnce(() => { throw new HostAuthorityError('stale') })
    const { client } = await authorityClient({ host, remoteUiRead: async () => ({ sessions: [] }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteUiRead({ ...lease, endpoint: 'session/list', payload: { args: {} } }))
      .rejects.toMatchObject({ code: 'stale' })
    client.close()
  })

  it('drops a remote UI read when its lease selects a different Profile after worker execution', async () => {
    const host = fakeHost()
    vi.mocked(host).authorizeExtensionView.mockReturnValueOnce(profileId as never)
      .mockReturnValueOnce(randomUUID() as never)
    const { client } = await authorityClient({ host, remoteUiRead: async () => ({ sessions: [] }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteUiRead({ ...lease, endpoint: 'session/list', payload: { args: {} } }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    client.close()
  })

  it('rejects a remote UI read response with the wrong method', async () => {
    const { client, transport } = await authorityClient({ remoteUiRead: async () => ({ sessions: [] }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    transport.call = async frame => ({ version: 1, type: 'result', request_id: frame.request_id,
      method: 'profile.remote_session', result: { value: null } })
    await expect(client.remoteUiRead({ ...lease, endpoint: 'session/list', payload: { args: {} } }))
      .rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('rejects oversized remote UI results before emitting a control frame', async () => {
    const { client } = await authorityClient({ remoteUiRead: async () => ({ value: 'x'.repeat(65_536) }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteUiRead({ ...lease, endpoint: 'session/list', payload: { args: {} } }))
      .rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('streams Session follow in short lease-authorized chunks and closes on connection loss', async () => {
    const host = fakeHost()
    let release!: (value: IteratorResult<unknown>) => void
    const stopped = vi.fn()
    const remoteUiStream = vi.fn((_profileId: string, _endpoint: string, _payload: unknown, signal: AbortSignal) => ({
      async *[Symbol.asyncIterator]() {
        try {
          yield { event: 'message', text: '界'.repeat(10_000) }
          await new Promise<IteratorResult<unknown>>((resolve) => {
            release = resolve
            signal.addEventListener('abort', () => { resolve({ done: true, value: undefined }) }, { once: true })
          })
        } finally { stopped() }
      },
    }))
    const { client, lifetime } = await authorityClient({ host, remoteUiStream })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    const stream_id = randomUUID()
    const request = { address: { kind: 'session' as const, sessionId: 'session-1' } }
    await expect(client.remoteUiStream({ ...lease, command: { action: 'open', stream_id,
      endpoint: 'session/follow', payload: { args: { request } } } })).resolves.toEqual({ type: 'opened' })
    expect(remoteUiStream).toHaveBeenCalledWith(profileId, 'session/follow',
      { args: { request } }, expect.any(AbortSignal))
    const chunks: string[] = []
    for (;;) {
      const item = await client.remoteUiStream({ ...lease, command: { action: 'poll', stream_id } })
      if (item.type === 'idle') { await Promise.resolve(); continue }
      expect(item.type).toBe('chunk')
      if (item.type !== 'chunk') break
      chunks.push(item.bytes)
      if (item.final) break
    }
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64url'))).toString())
      .toBe(JSON.stringify({ event: 'message', text: '界'.repeat(10_000) }))
    expect(vi.mocked(host).authorizeExtensionView.mock.calls.length).toBeGreaterThan(2)
    lifetime.abort()
    release({ done: true, value: undefined })
    await vi.waitFor(() => { expect(stopped).toHaveBeenCalledOnce() })
    client.close()
  })

  it('revokes an open Session-follow cursor when its view lease becomes stale', async () => {
    const host = fakeHost()
    const stopped = vi.fn()
    const { client } = await authorityClient({ host, remoteUiStream: (_profileId, _endpoint, _payload, signal) => ({
      async *[Symbol.asyncIterator]() {
        try {
          await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        } finally { stopped() }
      },
    }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    const stream_id = randomUUID()
    await client.remoteUiStream({ ...lease, command: { action: 'open', stream_id,
      endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } } } })
    vi.mocked(host).authorizeExtensionView.mockImplementation(() => { throw new HostAuthorityError('stale') })
    await expect(client.remoteUiStream({ ...lease, command: { action: 'poll', stream_id } }))
      .rejects.toMatchObject({ code: 'stale' })
    await vi.waitFor(() => { expect(stopped).toHaveBeenCalledOnce() })
    client.close()
  })

  it('keeps the native stream unavailable without an executor and refuses unknown cursors', async () => {
    const absent = await authorityClient()
    const selector = await localSelector(absent.client)
    const lease = await absent.client.openLocalProfile({ profileSelector: selector })
    await expect(absent.client.remoteUiStream({ ...lease, command: { action: 'poll', stream_id: randomUUID() } }))
      .rejects.toMatchObject({ code: 'upgrade_required' })
    const authorization = (absent.client as unknown as { auth(): Record<string, unknown> }).auth()
    const denied = await absent.session.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
      method: 'profile.remote_ui_stream', params: { ...authorization, view_lease_id: lease.viewLeaseId as never,
        lease_generation: lease.leaseGeneration, runtime_generation: lease.runtimeGeneration,
        command: { action: 'open', stream_id: randomUUID(), endpoint: 'session/follow',
          payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } },
      } } as never)
    expect(denied).toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
    absent.client.close()

    const active = await authorityClient({ remoteUiStream: async function* () { /* no items */ } })
    const activeSelector = await localSelector(active.client)
    const activeLease = await active.client.openLocalProfile({ profileSelector: activeSelector })
    await expect(active.client.remoteUiStream({ ...activeLease, command: { action: 'poll', stream_id: randomUUID() } }))
      .rejects.toMatchObject({ code: 'stale' })
    active.client.close()

    const host = fakeHost()
    vi.mocked(host).authorizeExtensionView.mockImplementation(() => { throw new HostAuthorityError('stale') })
    const revoked = await authorityClient({ host, remoteUiStream: async function* () { /* no items */ } })
    const revokedSelector = await localSelector(revoked.client)
    const revokedLease = await revoked.client.openLocalProfile({ profileSelector: revokedSelector })
    await expect(revoked.client.remoteUiStream({ ...revokedLease,
      command: { action: 'poll', stream_id: randomUUID() } })).rejects.toMatchObject({ code: 'stale' })
    revoked.client.close()
  })

  it('bounds a control connection to eight Session-follow cursors', async () => {
    const { client } = await authorityClient({ remoteUiStream: async function* () { /* no items */ } })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    const open = (stream_id: string) => client.remoteUiStream({ ...lease, command: { action: 'open', stream_id,
      endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } } } })
    for (let index = 0; index < 8; index += 1) {
      await expect(open(randomUUID())).resolves.toEqual({ type: 'opened' })
    }
    await expect(open(randomUUID())).rejects.toMatchObject({ code: 'conflict' })
    client.close()
  })

  it('rejects a malformed response to a native stream request', async () => {
    const { client, transport } = await authorityClient({ remoteUiStream: async function* () { /* no items */ } })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    transport.call = async frame => ({ version: 1, type: 'result', request_id: frame.request_id,
      method: 'profile.remote_ui_read', result: { value: null } })
    await expect(client.remoteUiStream({ ...lease, command: { action: 'poll', stream_id: randomUUID() } }))
      .rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('rejects duplicate Session-follow opens and permits explicit close', async () => {
    const stopped = vi.fn()
    const { client } = await authorityClient({ remoteUiStream: (_profileId, _endpoint, _payload, signal) => ({
      async *[Symbol.asyncIterator]() {
        try { await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        }) } finally { stopped() }
      },
    }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    const stream_id = randomUUID()
    const command = { action: 'open' as const, stream_id, endpoint: 'session/follow' as const,
      payload: { args: { request: { address: { kind: 'session' as const, sessionId: 'session-1' } } } } }
    await expect(client.remoteUiStream({ ...lease, command })).resolves.toEqual({ type: 'opened' })
    await expect(client.remoteUiStream({ ...lease, command })).rejects.toMatchObject({ code: 'conflict' })
    await expect(client.remoteUiStream({ ...lease, command: { action: 'close', stream_id } }))
      .resolves.toEqual({ type: 'closed' })
    await vi.waitFor(() => { expect(stopped).toHaveBeenCalledOnce() })
    client.close()
  })

  it('propagates clean and failed worker stream endings without details', async () => {
    for (const failure of [false, true]) {
      const { client } = await authorityClient({ remoteUiStream: async function* () {
        if (failure) throw new Error('private worker detail')
      } })
      const selector = await localSelector(client)
      const lease = await client.openLocalProfile({ profileSelector: selector })
      const stream_id = randomUUID()
      await client.remoteUiStream({ ...lease, command: { action: 'open', stream_id,
        endpoint: 'session/follow', payload: { args: { request: {
          address: { kind: 'session', sessionId: 'session-1' },
        } } } } })
      let result: Awaited<ReturnType<typeof client.remoteUiStream>>
      do {
        result = await client.remoteUiStream({ ...lease, command: { action: 'poll', stream_id } })
        if (result.type === 'idle') await Promise.resolve()
      } while (result.type === 'idle')
      expect(result).toEqual({ type: failure ? 'error' : 'end' })
      client.close()
    }
  })

  it('closes a newly opened cursor if its view changes during worker opening', async () => {
    const host = fakeHost()
    vi.mocked(host).authorizeExtensionView.mockReturnValueOnce(profileId as never)
      .mockReturnValueOnce(randomUUID() as never)
    const stopped = vi.fn()
    const { client } = await authorityClient({ host, remoteUiStream: (_profileId, _endpoint, _payload, signal) => ({
      async *[Symbol.asyncIterator]() {
        try { await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        }) } finally { stopped() }
      },
    }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    await expect(client.remoteUiStream({ ...lease, command: { action: 'open', stream_id: randomUUID(),
      endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } } } })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await vi.waitFor(() => { expect(stopped).toHaveBeenCalledOnce() })
    client.close()
  })

  it('closes an existing cursor if its view changes during polling', async () => {
    const host = fakeHost()
    const stopped = vi.fn()
    const { client } = await authorityClient({ host, remoteUiStream: (_profileId, _endpoint, _payload, signal) => ({
      async *[Symbol.asyncIterator]() {
        try { await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        }) } finally { stopped() }
      },
    }) })
    const selector = await localSelector(client)
    const lease = await client.openLocalProfile({ profileSelector: selector })
    const stream_id = randomUUID()
    await client.remoteUiStream({ ...lease, command: { action: 'open', stream_id,
      endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } } } })
    vi.mocked(host).authorizeExtensionView.mockReturnValueOnce(profileId as never)
      .mockReturnValueOnce(randomUUID() as never)
    await expect(client.remoteUiStream({ ...lease, command: { action: 'poll', stream_id } }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    await vi.waitFor(() => { expect(stopped).toHaveBeenCalledOnce() })
    client.close()
  })

  it('maps unavailable migration providers without exposing implementation failures', async () => {
    const absentExport = await authorityClient({ createMigrationExport: async () => undefined as never })
    const selector = await localSelector(absentExport.client)
    await expect(absentExport.client.getMigrationExportInventory({ sourceProfileSelector: selector }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    absentExport.client.close()

    const absentLegacy = await authorityClient({ createLegacyMigrationExport: async () => undefined as never })
    const legacySelector = await localSelector(absentLegacy.client)
    await expect(absentLegacy.client.getExistingMigrationSourceInventory({ targetProfileSelector: legacySelector }))
      .rejects.toMatchObject({ code: 'unavailable' })
    absentLegacy.client.close()

    const absentImport = await authorityClient({ createMigrationImport: () => undefined as never })
    const importSelector = await localSelector(absentImport.client)
    await expect(absentImport.client.stageMigrationImport({ transferId: randomUUID(), transferDigest: '3'.repeat(64),
      sourceInstallationId: installationId, sourceInventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1',
      sourceSchemaVersion: 1, targetGeneration: 4, recordCount: 1, semanticDigest: '4'.repeat(64),
      targetProfileSelector: importSelector })).rejects.toMatchObject({ code: 'unavailable' })
    absentImport.client.close()
  })

  it('returns a sanitized error from every migration operation failure', async () => {
    let failure: unknown
    const fail = () => { throw failure }
    const exportService: MigrationExportService = {
      inventory: async () => fail(),
      begin: async () => fail(),
      read: () => fail(),
    }
    const importService: MigrationImportService = {
      stage: async () => fail(), status: async () => fail(), verify: async () => fail(),
      commit: async () => fail(), abort: async () => fail(),
    }
    const { client } = await authorityClient({
      createMigrationExport: async () => exportService,
      createLegacyMigrationExport: async () => exportService,
      createMigrationImport: () => importService,
    })
    const selector = await localSelector(client)
    const migration = { transferId: randomUUID(), transferDigest: '3'.repeat(64), sourceInstallationId: installationId,
      sourceInventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1', sourceSchemaVersion: 1,
      targetGeneration: 4, recordCount: 1, semanticDigest: '4'.repeat(64), targetProfileSelector: selector }
    const cases: Array<[unknown, () => Promise<unknown>, string]> = [
      [new Error('migration_export_busy'), () => client.getExistingMigrationSourceInventory({ targetProfileSelector: selector }), 'busy'],
      [new Error('migration_export_not_found'), () => client.getMigrationExportInventory({ sourceProfileSelector: selector }), 'stale'],
      [new Error('migration_export_bounds_invalid'), () => client.beginMigrationExport({ sourceProfileSelector: selector,
        expectedInventoryDigest: proof.inventoryDigest, maxRecords: 8, maxBytes: 4_096 }), 'unavailable'],
      [new Error('migration_source_changed'), () => client.readMigrationExport({ sourceProfileSelector: selector,
        exportId: receipt.exportId, chunkIndex: 0 }), 'conflict'],
      [new Error('migration_import_invalid'), () => client.stageMigrationImport(migration), 'unavailable'],
      [new Error('migration_import_not_found'), () => client.getMigrationImportStatus(migration), 'stale'],
      [new Error('migration_import_state'), () => client.verifyMigrationImport({ importId: 'import-1', expectedStageVersion: 1,
        targetProfileSelector: selector }), 'conflict'],
      [new Error('migration_import_unsafe'), () => client.commitMigrationImport({ importId: 'import-1', expectedStageVersion: 1,
        expectedCurrentGeneration: 3, targetProfileSelector: selector }), 'unauthorized'],
      ['non-error', () => client.abortMigrationImport({ importId: 'import-1', expectedStageVersion: 1,
        targetProfileSelector: selector }), 'unavailable'],
    ]
    for (const [nextFailure, call, code] of cases) {
      failure = nextFailure
      await expect(call()).rejects.toMatchObject({ code })
    }
    client.close()
  })

  it('advertises and projects extension flags only for their matching kind', async () => {
    const scriptDigest = '9'.repeat(64)
    let committedScriptDigest: string | undefined
    let currentReceipt: Record<string, unknown> = {
      operationId, state: 'queued', cancellationRequested: false, createdAt: 1_000, updatedAt: 1_000,
    }
    const operations = {
      prepare: (authority: () => string, kind: HostExtensionKind) => ({ planId: 'plan-1', kind,
        digest: '8'.repeat(64), expiresAt: 20_000, profileId: authority(),
        ...(kind === 'plugin' ? { scriptApproval: { buildKey: 'demo@1.0.0', digest: scriptDigest,
          scripts: [{ name: 'postinstall', command: 'node build.js' }] } } : {}) }),
      commit: (authority: () => string, _planId: string, _operationId: string, _signal: AbortSignal,
        digest?: string) => { committedScriptDigest = digest; return { ...currentReceipt, profileId: authority() } },
      cancel: (authority: () => string) => ({ ...currentReceipt, profileId: authority() }),
      status: (authority: () => string) => ({ ...currentReceipt, profileId: authority() }),
      dispose: async () => undefined,
    } as unknown as ProfileExtensionOperations
    const extensions = { operations, kinds: ['plugin', 'skill', 'mcp'] as const,
      inventory: async () => [], pluginRemove: true, pluginUpdate: true, pluginToggle: true,
      skillArchives: true, skillRemove: true, skillReplace: true, skillFiles: true, skillInvocation: true,
      mcpRemove: true, mcpUpdate: true }
    const { client } = await authorityClient({ extensions })
    const selector = await localSelector(client)
    const profileLease = await client.openLocalProfile({ profileSelector: selector })
    for (const kind of extensions.kinds) {
      await expect(client.extensions({ ...profileLease, command: { action: 'inventory', kind } }))
        .resolves.toMatchObject({ state: 'inventory', kind })
    }
    const prepared = await client.extensions({ ...profileLease, command: { action: 'prepare', kind: 'skill', payload: '{}' } })
    expect(prepared).toMatchObject({ state: 'prepared', kind: 'skill' })
    await expect(client.extensions({ ...profileLease,
      command: { action: 'prepare', kind: 'plugin', payload: '{}' } })).resolves.toMatchObject({
      state: 'prepared', kind: 'plugin', scripts: [{ name: 'postinstall', command: 'node build.js' }],
      script_digest: scriptDigest,
    })
    await expect(client.extensions({ ...profileLease, command: { action: 'cancel', operation_id: operationId as never } }))
      .resolves.toMatchObject({ state: 'receipt', outcome: 'queued' })

    currentReceipt = { ...currentReceipt, state: 'unknown', reason: 'interrupted', skillSource: 'user-agents',
      canRestore: true, skillRemoval: { entryId: 'bundle-demo' }, restoredBy: operationId,
      restores: operationId, recoveryMode: 'restore' }
    await expect(client.extensions({ ...profileLease, command: { action: 'status', operation_id: operationId as never } }))
      .resolves.toMatchObject({ reason: 'interrupted', skill_source: 'user-agents', skill_restore: 'bundle-demo',
        restored_by: operationId, restores_operation: operationId })
    currentReceipt = { ...currentReceipt, skillRemoval: undefined, mcpRecovery: {}, pluginToggleRecovery: undefined,
      restoredBy: undefined, completedBy: operationId, recoveryMode: 'complete' }
    await expect(client.extensions({ ...profileLease, command: { action: 'status', operation_id: operationId as never } }))
      .resolves.toMatchObject({ mcp_restore: true, completed_by: operationId, completes_operation: operationId })
    currentReceipt = { ...currentReceipt, mcpRecovery: undefined, pluginToggleRecovery: { packageName: 'demo' },
      canComplete: true, pluginPackage: { action: 'install', packageName: 'demo', spec: 'demo@1.0.0' } }
    await expect(client.extensions({ ...profileLease, command: { action: 'status', operation_id: operationId as never } }))
      .resolves.toMatchObject({ plugin_restore: 'demo', plugin_complete: { action: 'install', package_name: 'demo', spec: 'demo@1.0.0' } })
    currentReceipt = { ...currentReceipt, pluginPackage: { action: 'remove', packageName: 'demo' } }
    await expect(client.extensions({ ...profileLease, command: { action: 'commit', plan_id: 'plan-1' as never,
      operation_id: operationId as never, script_digest: scriptDigest as never } }))
      .resolves.toMatchObject({ plugin_complete: { action: 'remove', package_name: 'demo' } })
    expect(committedScriptDigest).toBe(scriptDigest)
    client.close()

    const withoutFlags = await authorityClient({ extensions: { operations, kinds: extensions.kinds, inventory: async () => [] } })
    const withoutSelector = await localSelector(withoutFlags.client)
    const withoutLease = await withoutFlags.client.openLocalProfile({ profileSelector: withoutSelector })
    for (const kind of extensions.kinds) {
      await expect(withoutFlags.client.extensions({ ...withoutLease, command: { action: 'inventory', kind } }))
        .resolves.toEqual({ state: 'inventory', kind, entries: [] })
    }
    withoutFlags.client.close()
  })

  it('maps extension executor failures and rechecks authority after awaited inventory', async () => {
    let failure: unknown
    let abortDuringInventory = false
    const lifetime = new AbortController()
    const operations = {
      prepare: () => { throw failure },
      commit: () => { throw failure },
      cancel: () => { throw failure },
      status: () => { throw failure },
      dispose: async () => undefined,
    } as unknown as ProfileExtensionOperations
    const host = fakeHost()
    const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 3, now: () => 1_000,
      extensions: { operations, kinds: ['skill'], inventory: async () => {
        if (abortDuringInventory) lifetime.abort()
        return []
      } } })
    const session = authority.openSession(ownerId, lifetime.signal)
    const transport: HostClientFrameTransport = { call: frame => session.handleRequest(frame), isConnected: () => true,
      close: () => { session.close() } }
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      now: () => 1_000 }, transport)
    const selector = await localSelector(client)
    const profileLease = await client.openLocalProfile({ profileSelector: selector })
    const failures: Array<[unknown, string]> = [
      [new HostAuthorityError('busy'), 'busy'], [new Error('expired'), 'stale'], [new Error('busy'), 'busy'],
      [new Error('idempotency_conflict'), 'idempotency_conflict'], [new Error('unauthorized'), 'unauthorized'],
      [new Error('upgrade_required'), 'upgrade_required'], [new Error('script_approval_required'), 'script_approval_required'],
      ['non-error', 'unavailable'], [new Error('other'), 'unavailable'],
    ]
    for (const [nextFailure, code] of failures) {
      failure = nextFailure
      await expect(client.extensions({ ...profileLease, command: { action: 'prepare', kind: 'skill', payload: '{}' } }))
        .rejects.toMatchObject({ code })
    }
    abortDuringInventory = true
    await expect(client.extensions({ ...profileLease, command: { action: 'inventory', kind: 'skill' } }))
      .rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('uses default clocks, PEM keys, optional migration records, and profile failure redaction', async () => {
    const host = fakeHost()
    vi.spyOn(host, 'inspectOfflineAccountProfiles').mockResolvedValue({ candidates: [{
      state: 'recoverable', candidateId: 'candidate-1' as never, profileKind: 'account', bindingCount: 1,
      persistenceGeneration: 3, sessionCount: 1, pluginCount: 0, compatibility: 'current',
      preflightDigest: '8'.repeat(64), reasonCode: 'legacy_runtime_required',
    }] })
    vi.spyOn(host, 'getOfflineAccountRecoveryStatus').mockReturnValue({
      state: 'failed', reasonCode: 'recovery_worker_failed',
    })
    const exportService: MigrationExportService = {
      inventory: async () => proof,
      begin: async () => receipt,
      read: () => chunk,
    }
    const authority = new HostControlAuthority({
      identity: { ...identity, installationPrivateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) },
      host,
      profilePersistenceGeneration: () => 3,
      createMigrationExport: async () => exportService,
      createLegacyMigrationExport: async () => exportService,
    })
    const lifetime = new AbortController()
    const session = authority.openSession(ownerId, lifetime.signal)
    const transport: HostClientFrameTransport = { call: frame => session.handleRequest(frame), isConnected: () => true,
      close: () => { session.close() } }
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest }, transport)
    const selector = await localSelector(client)
    await expect(client.inspectOfflineAccountProfiles({ profileKeyHandles: ['key'] }))
      .resolves.toMatchObject({ candidates: [{ candidateId: 'candidate-1', reasonCode: 'legacy_runtime_required' }] })
    await expect(client.getOfflineAccountRecoveryStatus({ recoveryOperationId: operationId }))
      .resolves.toEqual({ state: 'failed', reasonCode: 'recovery_worker_failed' })
    await expect(client.readMigrationExport({ sourceProfileSelector: selector, exportId: receipt.exportId, chunkIndex: 0 }))
      .resolves.toMatchObject({ records: [{ id: 'session-1' }, { sessionId: 'session-1' }] })
    const legacy = await client.getExistingMigrationSourceInventory({ targetProfileSelector: selector })
    expect(legacy.expiresAt).toBeGreaterThan(Date.now())
    await expect(client.beginMigrationExport({ sourceProfileSelector: selector,
      sourceInventoryAuthority: legacy.sourceInventoryAuthority, expectedInventoryDigest: proof.inventoryDigest,
      maxRecords: 8, maxBytes: 4_096 })).resolves.toMatchObject({ exportId: receipt.exportId })

    vi.spyOn(host, 'getProfileStatus').mockImplementationOnce(() => { throw new Error('private implementation') })
    await expect(client.getProfileStatus({ authorityEnvironmentId: 'environment', accountBindingHandle: 'binding',
      authorityBindingVersion: 1 })).rejects.toMatchObject({ code: 'unavailable' })
    vi.spyOn(host, 'getProfileStatus').mockImplementationOnce(() => { throw new HostAuthorityError('invalid_input') })
    await expect(client.getProfileStatus({ authorityEnvironmentId: 'environment', accountBindingHandle: 'binding',
      authorityBindingVersion: 1 })).rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('rejects unsupported inspection, missing extension authority, and legacy ensure frames', async () => {
    const host = fakeHost()
    const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 3, now: () => 1_000 })
    const lifetime = new AbortController()
    const session = authority.openSession(ownerId, lifetime.signal)
    await expect(session.handleRequest({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'host.inspect',
      params: { challenge: 'A'.repeat(43) as never, client_instance_id: randomUUID() as never, supported_versions: [2] },
    })).rejects.toMatchObject({ code: 'unavailable' })

    let mutateEnsure = false
    const transport: HostClientFrameTransport = {
      call: (frame) => {
        if (mutateEnsure && frame.method === 'profile.ensure') {
          const ensureFrame = frame as ProfileEnsureRequest
          return session.handleRequest({ ...ensureFrame, params: { ...ensureFrame.params, account_access_token: '' } })
        }
        return session.handleRequest(frame)
      },
      isConnected: () => true,
      close: () => { session.close() },
    }
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      now: () => 1_000 }, transport)
    ;(client.inspection.capabilities as HostControlCapability[]).push('profile.extensions' as never)
    await expect(client.extensions({ ...opened, command: { action: 'inventory', kind: 'skill' } }))
      .rejects.toMatchObject({ code: 'upgrade_required' })
    mutateEnsure = true
    await expect(client.ensureAccountProfile({ authorityEnvironmentId: 'environment', accountBindingHandle: 'binding',
      authorityBindingVersion: 1, issuer: 'issuer', subject: 'subject', accountAccessToken: 'token',
      keyHandle: 'key', unlockMaterial: 'material' })).rejects.toMatchObject({ code: 'upgrade_required' })
    client.close()
  })
})
