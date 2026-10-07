import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { parseHostCollaborationSourceTarget, parseHostSourceAuthorityChallenge,
  parseHostCollaborationDeliveryCapsule } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProfileWorkerFactory } from '../src/types.ts'
import type { WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'
import {
  startWindowsDesktopHostApplication,
  startWindowsDesktopHostApplicationFromPrivateFiles,
  type StartWindowsDesktopHostApplicationDependencies,
} from '../src/windows-startup.ts'
import { WindowsHostTransport, type StartWindowsHostTransportOptions } from '../src/windows-host-transport.ts'
import { WindowsHostCarrier } from '../src/windows-host-carrier.ts'
import { acquireWindowsSingleHostLock } from '../src/windows-single-instance.ts'
import { UnixHostClient } from '../src/unix-transport.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
const issuer = 'https://accounts.dsh.colorbuyai.com'
const accountId = '30000000-0000-4000-8000-000000000003'

afterEach(() => { vi.restoreAllMocks() })

function accountToken(key: KeyObject, now: number): string {
  const issuedAt = Math.floor(now / 1_000)
  const header = Buffer.from(JSON.stringify({
    alg: 'ES256', kid: 'identity-2026-09', typ: 'dsh-access+jwt',
  })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    ag: 3, aud: 'dsh-host', exp: issuedAt + 600, iat: issuedAt, iss: issuer,
    jti: '50000000-0000-4000-8000-000000000005', kg: 7, nbf: issuedAt,
    sg: 5, sid: '40000000-0000-4000-8000-000000000004', sub: accountId,
    typ: 'dsh-access+jwt',
  })).toString('base64url')
  const input = `${header}.${payload}`
  return `${input}.${sign('sha256', Buffer.from(input, 'ascii'), {
    key, dsaEncoding: 'ieee-p1363',
  }).toString('base64url')}`
}

function fixture() {
  const installationKeys = generateKeyPairSync('ed25519')
  const accountKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const accountAccessKeyring = JSON.stringify({
    version: 2,
    issuer,
    keys: [{ kid: 'identity-2026-09', publicJwk: accountKeys.publicKey.export({ format: 'jwk' }) }],
  })
  const installationPublicKey = installationKeys.publicKey
    .export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const files = new Map<string, Buffer>()
  const pathEvidence = (kind: 'directory' | 'file') => ({
    kind,
    reparsePoint: false,
    linkCount: 1,
    ownerSid: userSid,
    daclProtected: true,
    access: [
      { sid: userSid, type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-18', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-32-544', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
    ],
  })
  const createPrivateFile = vi.fn<NonNullable<WindowsHostRegistrationFileBindings['createPrivateFile']>>((path, contents) => {
    if (files.has(path)) return { state: 'exists', evidence: pathEvidence('file') }
    files.set(path, Buffer.from(contents))
    return { state: 'created', evidence: pathEvidence('file') }
  })
  const readPrivateFile = vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((path) => {
    const contents = files.get(path)
    return contents === undefined ? undefined : { contents, evidence: pathEvidence('file') }
  })
  const replacePrivateFile = vi.fn<WindowsHostRegistrationFileBindings['replacePrivateFile']>((path, contents) => {
    files.set(path, Buffer.from(contents)); return pathEvidence('file')
  })
  const bindings: WindowsHostRegistrationFileBindings = {
    inspectExistingDirectory: vi.fn(() => pathEvidence('directory')),
    ensurePrivateDirectory: vi.fn(() => pathEvidence('directory')),
    createPrivateFile,
    readPrivateFile,
    replacePrivateFile,
    removePrivateFile: (path, expected, _sid, guard) => {
      if (!files.get(path)?.equals(expected)) throw Error('revision_conflict')
      guard(); files.delete(path)
    },
    acquirePrivateFileLease: vi.fn(() => ({
      evidence: pathEvidence('file'), initialize: vi.fn(), release: vi.fn(),
    })),
  }
  const dispose = vi.fn(async () => { await transportOptions?.quiesceOwnedResources() })
  const createProfileWorker = vi.fn<ProfileWorkerFactory>(async () => ({
    closeNotifications: vi.fn(), abort: vi.fn(), done: Promise.resolve(),
    viewOrigin: 'http://127.0.0.1:49152', generation: 1,
    bootstrapCookie: { name: 'dsh-auth-test', value: 'v1.test.test' },
  }))
  const createProfileWorkerFactory = vi.fn(() => createProfileWorker)
  let transportOptions: StartWindowsHostTransportOptions | undefined
  const startTransport = vi.fn<NonNullable<StartWindowsDesktopHostApplicationDependencies['startTransport']>>(async (
    options,
    transportDependencies = {},
  ) => {
    if (transportDependencies.loadCancellation === undefined
      || transportDependencies.loadCurrentUserSid === undefined
      || transportDependencies.loadRegistrationFileBindings === undefined) throw new Error('missing test authority')
    await transportDependencies.loadCancellation()
    const resolveCurrentUserSid = await transportDependencies.loadCurrentUserSid()
    const sharedBindings = await transportDependencies.loadRegistrationFileBindings()
    const resolvedUserSid = resolveCurrentUserSid()
    const ownership = acquireWindowsSingleHostLock({
      root: options.registrationRoot,
      userSid: resolvedUserSid,
      pid: process.pid,
      processNonce: options.processNonce,
      bindings: sharedBindings,
    })
    await options.initializeOwnedResources({ userSid: resolvedUserSid, bindings: sharedBindings })
    transportOptions = options
    const carrier = new WindowsHostCarrier({
      state: 'ready',
      waitUntilReady: async () => undefined,
      stop: async () => ({ state: 'stopped', cancelAttempts: 0, sessionCleanup: 'closed' }),
    }, options.processFallback, undefined)
    return new WindowsHostTransport(carrier, ownership, dispose, options.processFallback)
  })
  const loadCurrentUserSid = vi.fn(async () => () => userSid)
  const loadRegistrationFileBindings = vi.fn(async () => bindings)
  const loadWorkerIoCancellation = vi.fn(async () => ({
    openCurrentThreadHandle: vi.fn(() => 1n),
    abandonUnhandedThreadHandle: vi.fn(),
    cancel: vi.fn(() => 'cancelled' as const),
    close: vi.fn(),
  }))
  const attestListener = vi.fn(async () => undefined)
  const loadProfileListenerAttestor = vi.fn(async () => attestListener)
  const dependencies = {
    loadCurrentUserSid,
    loadRegistrationFileBindings,
    loadProfileListenerAttestor,
    loadWorkerIoCancellation,
    createProfileWorkerFactory,
    startTransport,
  } as unknown as StartWindowsDesktopHostApplicationDependencies
  const deadline = (signal: AbortSignal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  const options = {
    platform: 'win32',
    arch: 'x64',
    root,
    registrationRoot: `${root}\\host`,
    nodeExecutablePath: String.raw`C:\Program Files\Slark\resources\dsh-runtime\node.exe`,
    dshEntrypointPath: String.raw`C:\Program Files\Slark\resources\dsh-runtime\dsh.js`,
    workerEntry: new URL('file:///C:/Program%20Files/Slark/resources/dsh-runtime/windows-host-pipe-worker-entry.js'),
    deviceIndexKey: Buffer.alloc(32, 3),
    accountAccessKeyring,
    accountKeyringSha256: createHash('sha256').update(accountAccessKeyring).digest('hex'),
    installationPrivateKey: installationKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    installationPublicKey,
    installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3125',
    endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3126',
    hostInstanceId: '11111111-1111-4111-8111-111111111111',
    processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
    executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 1,
    schemaGeneration: 1,
    allowedPublisherThumbprints: new Set(['B'.repeat(64)]),
    allowedDesktopExecutableDigests: new Set(['2'.repeat(64)]),
    nativeModule: {
      path: String.raw`C:\Program Files\Slark\resources\dsh-runtime\native\win32-x64\koffi.node`,
      sha256: '3'.repeat(64),
    },
    maximumRegistryBytes: 64 * 1024,
    maximumManagedFileBytes: 64 * 1024,
    maximumJournalBytes: 1024 * 1024,
    profileReadyTimeoutMs: 30_000,
    profileAbortTimeoutMs: 5_000,
    workerGeneration: 1,
    maxCancelAttempts: 4,
    waitForCancelRetry: vi.fn(async () => undefined),
    startupDeadline: deadline,
    exitWithoutHandleDeadline: deadline,
    sessionCleanupDeadline: deadline,
    processFallback: vi.fn(async () => undefined),
  }
  return {
    options, dependencies, files, createProfileWorker, createProfileWorkerFactory,
    startTransport, loadCurrentUserSid, loadRegistrationFileBindings,
    loadProfileListenerAttestor, loadWorkerIoCancellation, attestListener, dispose, readPrivateFile,
    accountAccessKeyring,
    accountPrivateKey: accountKeys.privateKey,
    installationKeyObject: installationKeys.privateKey,
    installationPrivateKey: installationKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    transportOptions: () => transportOptions,
  }
}

describe('Windows Desktop Host startup', () => {
  it('wires Account-authorized collaboration readers and refuses an uncertified worker delivery commit', async () => {
    const state = fixture(), now = 1_780_000_000_000
    const target = parseHostCollaborationSourceTarget({ workspace_id: randomUUID(), session_id: 'original',
      source_message_id: 'message', source_revision: '1' })
    const descriptor = { ...target, snapshot_digest: 'a'.repeat(64) }
    const snapshot = { descriptor, snapshot_json: JSON.stringify({ ...target,
      original_message: '@Guide · Project repair', active_mentions: [], model_snapshot: { provider: 'deepseek', model: 'chat' },
      host_journal_commit: { journal_id: 'journal', commit_version: '1', content_digest: 'b'.repeat(64) },
    }) }
    const inspect = vi.fn(async () => descriptor), read = vi.fn(async () => snapshot)
    const receive = vi.fn(async () => null), analysis = vi.fn(async () => null)
    state.createProfileWorker.mockImplementation(async () => ({
      closeNotifications: vi.fn(), abort: vi.fn(), done: Promise.resolve(),
      viewOrigin: 'http://127.0.0.1:49152', generation: 1,
      bootstrapCookie: { name: 'dsh-auth-test', value: 'v1.test.test' },
      inspectWorkspaceModelSelection: async value => ({ ...value, provider: 'deepseek', model: 'chat' }),
      inspectCollaborationSource: inspect, readCollaborationSourceSnapshot: read, receiveCollaborationDelivery: receive,
      collaborationAnalysis: analysis,
    }))
    const application = await startWindowsDesktopHostApplication(state.options, { now: () => now }, state.dependencies)
    onTestFinished(async () => { await application.close() })
    const lifetime = new AbortController(), session = state.transportOptions()?.openSession(randomUUID(), lifetime.signal)
    if (!session) throw Error('missing collaboration control session')
    onTestFinished(async () => { lifetime.abort(); await session.close() })
    const client = await UnixHostClient.connectAuthenticatedTransport({
      trustedInstallationId: state.options.installationId, trustedInstallationPublicKey: state.options.installationPublicKey,
      trustedExecutableSignatureDigest: state.options.executableSignatureDigest, now: () => now,
    }, { call: async (frame, signal) => session.handleRequest(frame, signal ?? lifetime.signal),
      isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort() } })
    onTestFinished(() => { client.close() })
    const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:collaboration',
      authorityBindingVersion: 1, issuer, subject: accountId }
    const selection = { ...account, workspace_id: target.workspace_id, session_id: target.session_id }
    await expect(client.inspectWorkspaceModelSelection(selection)).rejects.toMatchObject({ code: 'unauthorized' })
    await client.ensureAccountProfile({ ...account, accountAccessToken: accountToken(state.accountPrivateKey, now),
      keyHandle: 'windows-credential:account', unlockMaterial })
    await expect(client.inspectWorkspaceModelSelection(selection))
      .resolves.toEqual({ workspace_id: target.workspace_id, session_id: target.session_id, provider: 'deepseek', model: 'chat' })
    expect(await client.collaborationAnalysis({ ...account, command: { action: 'root_feedback', operation: { action: 'read' } } })).toEqual({ kind: 'root_feedback', record: null })
    expect(analysis).toHaveBeenCalledOnce()
    const challenge = parseHostSourceAuthorityChallenge({ request_id: randomUUID(), challenge_nonce: 'A'.repeat(43),
      expires_at: now + 1000, audience: 'https://slark.example.test', environment_id: account.authorityEnvironmentId,
      account_issuer: issuer, account_subject: accountId, ...target, snapshot_digest: descriptor.snapshot_digest, host_epoch: '1' })
    await expect(client.attestSourceAuthority({ ...account, challenge })).resolves.toMatchObject({ challenge: descriptor })
    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledWith(target, expect.any(AbortSignal))
    await expect(client.readCollaborationSourceSnapshot({ ...account, ...target, accountIssuer: issuer, accountSubject: accountId }))
      .resolves.toEqual(snapshot)
    expect(read).toHaveBeenCalledWith(target, expect.any(AbortSignal))
    const capsule = parseHostCollaborationDeliveryCapsule({ namespace_id: 'namespace', projection: {
      delivery_id: 'delivery', invocation_id: 'invocation', plan_id: 'plan', task_id: 'task', task_revision: '1',
      source_locator: target, source_snapshot_digest: descriptor.snapshot_digest, execution_state: 'succeeded',
      invocation_state_version: '2', answer: 'repaired',
      result_digest: createHash('sha256').update(JSON.stringify({ answer: 'repaired', failure_code: null,
        state: 'succeeded' })).digest('hex'), target: { project_id: 'project', agent_id: 'agent' },
      target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' }, delivery_state: 'pending', delivery_state_version: '1',
    } })
    await expect(client.receiveCollaborationDelivery({ ...account, capsule })).rejects.toThrow()
    expect(receive).toHaveBeenCalledOnce()
    expect(receive).toHaveBeenCalledWith(capsule, expect.any(AbortSignal))
  })

  it('advertises opted-in MCP and commits through the authenticated control session after worker acknowledgement', async () => {
    const state = fixture()
    const application = await startWindowsDesktopHostApplication({ ...state.options, maximumExtensionReceiptBytes: 131072 },
      undefined, state.dependencies)
    const lifetime = new AbortController()
    const session = state.transportOptions()?.openSession(randomUUID(), lifetime.signal)
    if (!session) throw Error('missing session')
    const client = await UnixHostClient.connectAuthenticatedTransport({
      trustedInstallationId: state.options.installationId,
      trustedInstallationPublicKey: state.options.installationPublicKey,
      trustedExecutableSignatureDigest: state.options.executableSignatureDigest,
    }, { call: async (frame, signal) => session.handleRequest(frame, signal ?? lifetime.signal),
      isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort() } })
    let patch = ''
    const observed = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(url).toBe('http://127.0.0.1:49152/api/pluginInventory/list')
      expect(state.files.get(patch)?.toString()).toContain('mcp-demo')
      if (typeof options?.body !== 'string') throw Error('missing RPC body')
      const request = JSON.parse(options.body) as { rpcId: string }
      return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: {
        entries: [{ entryId: 'include:mcp-demo', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active' }],
      } } }))
    })
    try {
      expect(client.inspection.capabilities).toContain('profile.extensions')
      const local = await client.bootstrapLocalProfile({ keyHandle: 'windows-credential:local', unlockMaterial })
      const lease = await client.openLocalProfile({ profileSelector: local.profileSelector })
      await expect(client.remoteSession({ ...lease, command: { operation: 'session.list', command_id: randomUUID() as never } }))
        .rejects.toMatchObject({ code: 'unavailable' })
      await expect(client.remoteUiRead({ ...lease, endpoint: 'boot/injections', payload: { args: {} } }))
        .rejects.toMatchObject({ code: 'unavailable' })
      await expect(client.remoteUiStream({ ...lease, command: {
        action: 'open', stream_id: randomUUID(), endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } },
      } })).rejects.toMatchObject({ code: 'unavailable' })
      patch = `${root}\\profiles\\${local.profileId}\\profiles\\web\\cordis.patch.yml`
      expect(await client.extensions({ ...lease, command: { action: 'inventory', kind: 'mcp' } }))
        .toMatchObject({ state: 'inventory', entries: [], mcp_remove: true, mcp_update: true })
      await expect(client.extensions({ ...lease, command: { action: 'inventory', kind: 'plugin' } }))
        .rejects.toMatchObject({ code: 'upgrade_required' })
      const plan = await client.extensions({ ...lease, command: { action: 'prepare', kind: 'mcp',
        payload: JSON.stringify({ mcpServers: { demo: { url: 'https://example.com/mcp' } } }) } })
      if (plan.state !== 'prepared') throw Error('missing plan')
      const operationId = randomUUID() as never
      await client.extensions({ ...lease, command: { action: 'commit', plan_id: plan.plan_id, operation_id: operationId } })
      await expect.poll(async () => client.extensions({ ...lease, command: { action: 'status', operation_id: operationId } }))
        .toMatchObject({ state: 'receipt', outcome: 'succeeded' })
      expect(observed).toHaveBeenCalledOnce()
      expect(state.createProfileWorker).toHaveBeenCalledTimes(2)
      expect(state.files.get(`${root}\\control\\extensions.v1.json`)?.toString()).toContain(operationId)
      let acknowledgeStarted = () => {}
      const started = new Promise<void>((resolve) => { acknowledgeStarted = resolve })
      let requestAborted = false
      observed.mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal
        if (!signal) throw Error('missing operation lifetime')
        signal.addEventListener('abort', () => { requestAborted = true; reject(new Error('acknowledgement_aborted')) }, { once: true })
        acknowledgeStarted()
      }))
      const pending = await client.extensions({ ...lease, command: { action: 'prepare', kind: 'mcp',
        payload: JSON.stringify({ mcpServers: { demo: { url: 'https://example.com/mcp' } } }) } })
      if (pending.state !== 'prepared') throw Error('missing pending plan')
      const pendingId = randomUUID() as never
      await client.extensions({ ...lease, command: { action: 'commit', plan_id: pending.plan_id, operation_id: pendingId } })
      await started
      await application.close()
      expect(requestAborted).toBe(true)
      const saved = JSON.parse(state.files.get(`${root}\\control\\extensions.v1.json`)!.toString()) as {
        receipts: Array<{ operationId: string; state: string }>
      }
      expect(saved.receipts.find(receipt => receipt.operationId === pendingId)).toMatchObject({ state: 'unknown' })
    } finally { observed.mockRestore(); client.close(); await application.close() }
  })
  it('starts local-only DSH without migration capability and prepares an isolated Profile on demand', async () => {
    const state = fixture()
    const application = await startWindowsDesktopHostApplication(state.options, undefined, state.dependencies)
    const local = await application.host.bootstrapLocalProfile({
      keyHandle: 'windows-credential:local', unlockMaterial, ownerId: 'desktop-owner',
    })

    expect(application.host.supportsOfflineAccountRecovery()).toBe(false)
    expect(state.loadCurrentUserSid).toHaveBeenCalledOnce()
    expect(state.loadRegistrationFileBindings).toHaveBeenCalledOnce()
    expect(state.loadProfileListenerAttestor).toHaveBeenCalledOnce()
    expect(state.createProfileWorkerFactory).toHaveBeenCalledWith(expect.objectContaining({
      attestListener: state.attestListener,
      readyTimeoutMs: 30_000,
      abortTimeoutMs: 5_000,
    }))
    expect(state.createProfileWorker).toHaveBeenCalledWith(expect.objectContaining({
      profileId: local.profileId,
      profileRoot: `${root}\\profiles\\${local.profileId}`,
      pluginRoots: [`${root}\\profiles\\${local.profileId}\\plugins`],
    }))
    const inspectionAbort = new AbortController()
    expect(state.transportOptions()?.openSession('11111111-1111-4111-8111-111111111112', inspectionAbort.signal)).toBeDefined()
    await application.close()
    expect(state.dispose).toHaveBeenCalledOnce()
  })

  it('blocks only the Profile with a durable pending model claim after restart', async () => {
    const state = fixture()
    const first = await startWindowsDesktopHostApplication(state.options, undefined, state.dependencies)
    const local = await first.host.bootstrapLocalProfile({
      keyHandle: 'windows-credential:local', unlockMaterial, ownerId: 'desktop-owner',
    })
    await first.close()
    state.files.set(`${root}\\profiles\\${local.profileId}\\legacy-model-claim.v1.json`, Buffer.from(JSON.stringify({
      version: 1, profileId: local.profileId, candidateId: 'llm-deepseek:deepseek',
      operationId: randomUUID(), state: 'pending',
    })))
    const second = await startWindowsDesktopHostApplication(state.options, undefined, state.dependencies)
    try {
      await expect(second.host.restoreLocalProfile({
        profileId: local.profileId, bindingGeneration: local.bindingGeneration,
        keyHandle: 'windows-credential:local', unlockMaterial, ownerId: 'desktop-owner',
      }))
        .rejects.toMatchObject({ code: 'unavailable' })
      expect(state.createProfileWorker).toHaveBeenCalledTimes(1)
    } finally { await second.close() }
  })

  it('rejects unsupported platforms and mismatched trust material before loading native authority', async () => {
    for (const change of [
      { platform: 'darwin' },
      { arch: 'arm64' },
      { root: 'C:\\' },
      { root: String.raw`C:\Users\alice\bad:name` },
      { root: String.raw`C:\Users\alice\temp\..\DSH` },
      { root: `C:\\Users\\alice\\${String.fromCharCode(1)}DSH` },
      { registrationRoot: 'host' },
      { registrationRoot: String.raw`C:\Users\alice\.dsh\host` },
      { nodeExecutablePath: 'node.exe' },
      { dshEntrypointPath: 'dsh.js' },
      { workerEntry: new URL('https://example.com/worker.js') },
      { nativeModule: { ...fixture().options.nativeModule, path: 'koffi.node' } },
      { nativeModule: { ...fixture().options.nativeModule, path: String.raw`C:\native\..\koffi.node` } },
      { nativeModule: { ...fixture().options.nativeModule, path: String.raw`C:\native\other.node` } },
      { nativeModule: { ...fixture().options.nativeModule, sha256: 'X'.repeat(64) } },
      { accountKeyringSha256: 'invalid' },
      { accountKeyringSha256: '0'.repeat(64) },
      { installationPublicKey: 'invalid' },
      { installationPublicKey: 'A'.repeat(43) },
      { runtimeGeneration: 0 },
      { schemaGeneration: 1.5 },
      { maximumRegistryBytes: 0 },
      { maximumManagedFileBytes: Number.MAX_SAFE_INTEGER + 1 },
      { maximumJournalBytes: 0 },
      { profileReadyTimeoutMs: 0 },
      { maximumExtensionReceiptBytes: 0 },
      { profileAbortTimeoutMs: 0 },
    ]) {
      const state = fixture()
      await expect(startWindowsDesktopHostApplication(
        { ...state.options, ...change }, undefined, state.dependencies,
      )).rejects.toThrow()
      expect(state.loadCurrentUserSid).not.toHaveBeenCalled()
      expect(state.startTransport).not.toHaveBeenCalled()
    }
  })

  it('accepts a KeyObject identity and wires account clock and view activation callbacks', async () => {
    const state = fixture()
    const now = 1_780_000_000_000
    const clock = { now: vi.fn(() => now) }
    const application = await startWindowsDesktopHostApplication({
      ...state.options,
      installationPrivateKey: state.installationKeyObject,
    }, clock, state.dependencies)
    const local = await application.host.bootstrapLocalProfile({
      keyHandle: 'windows-credential:local', unlockMaterial, ownerId: 'local-owner',
    })
    const opened = await application.host.openLocalProfile({ profileId: local.profileId, ownerId: 'local-owner' })
    await expect(application.host.activateView({
      profileId: opened.profileId,
      viewLeaseId: opened.viewLeaseId,
      viewActivationHandle: opened.viewActivationHandle,
      leaseGeneration: opened.leaseGeneration,
      runtimeGeneration: opened.runtimeGeneration,
      ownerId: 'local-owner',
    })).resolves.toMatchObject({ origin: 'http://127.0.0.1:49152', activationGeneration: 1 })
    await expect(application.host.ensureAccountProfile({
      issuer,
      subject: accountId,
      authorityEnvironmentId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181',
      accountBindingHandle: 'binding:account',
      authorityBindingVersion: 1,
      accountAccessToken: accountToken(state.accountPrivateKey, now),
      keyHandle: 'windows-credential:account',
      unlockMaterial,
      ownerId: 'account-owner',
    })).resolves.toMatchObject({ bindingGeneration: 1 })
    expect(clock.now).toHaveBeenCalled()
    await application.close()
  })

  it('uses platform defaults and forwards an optional failure observer', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    const state = fixture()
    const { platform: _platform, arch: _arch, ...base } = state.options
    const onFailure = vi.fn()
    const application = await startWindowsDesktopHostApplication({ ...base, onFailure }, undefined, state.dependencies)
    const local = await application.host.bootstrapLocalProfile({
      keyHandle: 'windows-credential:local', unlockMaterial, ownerId: 'default-owner',
    })
    expect(state.createProfileWorker).toHaveBeenCalledWith(expect.objectContaining({ profileId: local.profileId }))
    expect(state.transportOptions()).not.toHaveProperty('platform')
    expect(state.transportOptions()).not.toHaveProperty('arch')
    expect(state.transportOptions()?.onFailure).toBe(onFailure)
    await application.close()
  })

  it('rejects malformed in-memory private keys without exposing the crypto failure', async () => {
    const state = fixture()
    await expect(startWindowsDesktopHostApplication({
      ...state.options,
      installationPrivateKey: 'not-a-private-key',
    }, undefined, state.dependencies)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(state.startTransport).not.toHaveBeenCalled()
  })

  it('loads exact ACL-pinned identity files only from the lock-owned initializer', async () => {
    const state = fixture()
    const identityRoot = `${root}\\identity`
    state.files.set(`${identityRoot}\\device-index-key.v1`, Buffer.alloc(32, 3))
    state.files.set(`${identityRoot}\\account-access-keyring.v2.json`, Buffer.from(state.accountAccessKeyring))
    state.files.set(`${identityRoot}\\installation-private-key.pem`, Buffer.from(state.installationPrivateKey))
    const startTransport = state.dependencies.startTransport
    if (startTransport === undefined) throw new Error('missing transport seam')
    const checkedStartTransport = vi.fn<NonNullable<
      StartWindowsDesktopHostApplicationDependencies['startTransport']
    >>(async (options, dependencies) => {
      expect(state.readPrivateFile).not.toHaveBeenCalled()
      return startTransport(options, dependencies)
    })

    const application = await startWindowsDesktopHostApplicationFromPrivateFiles({
      ...state.options,
      deviceIndexKeyPath: `${identityRoot}\\device-index-key.v1`,
      accountKeyringPath: `${identityRoot}\\account-access-keyring.v2.json`,
      installationPrivateKeyPath: `${identityRoot}\\installation-private-key.pem`,
    }, undefined, { ...state.dependencies, startTransport: checkedStartTransport })

    expect(state.readPrivateFile.mock.calls.slice(0, 3).map(([path]) => path)).toEqual([
      `${identityRoot}\\device-index-key.v1`,
      `${identityRoot}\\account-access-keyring.v2.json`,
      `${identityRoot}\\installation-private-key.pem`,
    ])
    await application.close()
  })

  it('rejects identity paths outside the isolated root before loading native authority', async () => {
    const state = fixture()
    await expect(startWindowsDesktopHostApplicationFromPrivateFiles({
      ...state.options,
      deviceIndexKeyPath: String.raw`C:\Users\alice\.dsh\device-index-key`,
      accountKeyringPath: `${root}\\identity\\account-access-keyring.v2.json`,
      installationPrivateKeyPath: `${root}\\identity\\installation-private-key.pem`,
    }, undefined, state.dependencies)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(state.loadCurrentUserSid).not.toHaveBeenCalled()
    expect(state.readPrivateFile).not.toHaveBeenCalled()
  })

  it('rejects missing, empty, oversized, truncated, non-UTF8, and malformed private identity files', async () => {
    const cases: Array<{
      readonly prepare: (state: ReturnType<typeof fixture>, identityRoot: string) => void
      readonly code: 'invalid_input' | 'unavailable'
    }> = [
      { prepare: () => undefined, code: 'unavailable' },
      { prepare: (state, identityRoot) => {
        state.files.set(`${identityRoot}\\device-index-key.v1`, Buffer.alloc(0))
      }, code: 'unavailable' },
      { prepare: (state, identityRoot) => {
        state.files.set(`${identityRoot}\\device-index-key.v1`, Buffer.alloc(33))
      }, code: 'unavailable' },
      { prepare: (state, identityRoot) => {
        state.files.set(`${identityRoot}\\device-index-key.v1`, Buffer.alloc(31))
      }, code: 'unavailable' },
      { prepare: (state, identityRoot) => {
        state.files.set(`${identityRoot}\\device-index-key.v1`, Buffer.alloc(32, 3))
        state.files.set(`${identityRoot}\\account-access-keyring.v2.json`, Buffer.from([0xff]))
        state.files.set(`${identityRoot}\\installation-private-key.pem`, Buffer.from(state.installationPrivateKey))
      }, code: 'unavailable' },
      { prepare: (state, identityRoot) => {
        state.files.set(`${identityRoot}\\device-index-key.v1`, Buffer.alloc(32, 3))
        state.files.set(`${identityRoot}\\account-access-keyring.v2.json`, Buffer.from(state.accountAccessKeyring))
        state.files.set(`${identityRoot}\\installation-private-key.pem`, Buffer.from('not-a-private-key'))
      }, code: 'invalid_input' },
    ]
    for (const testCase of cases) {
      const state = fixture()
      const identityRoot = `${root}\\identity`
      testCase.prepare(state, identityRoot)
      await expect(startWindowsDesktopHostApplicationFromPrivateFiles({
        ...state.options,
        deviceIndexKeyPath: `${identityRoot}\\device-index-key.v1`,
        accountKeyringPath: `${identityRoot}\\account-access-keyring.v2.json`,
        installationPrivateKeyPath: `${identityRoot}\\installation-private-key.pem`,
      }, undefined, state.dependencies)).rejects.toMatchObject({ code: testCase.code })
    }
  })

  it('fails closed before owned-resource initialization and contains cleanup rejection', async () => {
    for (const closeFailure of [undefined, new Error('private close failure')]) {
      const state = fixture()
      const close = closeFailure === undefined
        ? vi.fn(async () => undefined)
        : vi.fn(async () => { throw closeFailure })
      const startTransport = vi.fn(async (options: StartWindowsHostTransportOptions) => {
        expect(() => options.openSession(randomUUID(), new AbortController().signal))
          .toThrow(expect.objectContaining({ code: 'unavailable' }))
        await options.quiesceOwnedResources()
        return { close } as unknown as WindowsHostTransport
      })
      await expect(startWindowsDesktopHostApplication(
        state.options, undefined, { ...state.dependencies, startTransport },
      )).rejects.toMatchObject({ code: 'unavailable' })
      expect(close).toHaveBeenCalledOnce()
    }
  })
})
