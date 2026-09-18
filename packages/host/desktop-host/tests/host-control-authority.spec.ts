import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
  type HostInspectRequest,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { DesktopModelWorkerError } from '../src/dsh-web-profile-worker.ts'
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
    if (inspection.type === 'result' && inspection.method === 'host.inspect') {
      expect(inspection.result.capabilities).not.toContain('profile.model_claim_inventory')
    }
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
    await expect(session.handleRequest({
      version: 1, type: 'request', request_id: randomUUID() as never,
      method: 'profile.model_claim_inventory', params: {
        client_instance_id: clientInstanceId as never, host_instance_id: hostInstanceId as never,
        process_nonce: processNonce as never, jti: randomUUID() as never,
        issued_at: now, expires_at: now + 1_000,
        view_lease_id: randomUUID() as never, lease_generation: 1, runtime_generation: 5,
      },
    })).resolves.toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
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

  it('requires token-verified Account lease before and after legacy model inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-model-claim-authority-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const keys = generateKeyPairSync('ed25519')
    const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(-32).toString('base64url')
    const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => now } })
    const binding = { authorityEnvironmentId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181',
      accountBindingHandle: 'binding:model-claim', authorityBindingVersion: 1 }
    const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
    const profile = await registry.registerAccount({
      issuer: 'https://accounts.example.test', subject: 'owner', keyHandle: 'keychain:model-claim',
      unlockMaterial, ...binding,
    })
    const host = new DesktopHost({
      registry, clock: { now: () => now }, runtimeGeneration: 5,
      ensureProfileWorker: async () => undefined,
      verifyAccountAccessToken: (token) => {
        if (token !== 'valid-token') throw Error('invalid token')
        return { issuer: 'https://accounts.example.test', subject: 'owner' }
      },
    })
    const inventory = { sourceDigest: 'a'.repeat(64), candidates: [{
      id: 'llm-deepseek:deepseek', provider: 'deepseek', kind: 'llm' as const,
      credential: 'present' as const, sharedCredential: false,
    }], unsupportedSettings: 0, unassignedCredentialReferences: 0, unassignedCredentialRecords: 0 }
    const inspectSource = vi.fn(async () => inventory)
    const generateModelText = vi.fn(async (_profileId: string, text: string, _signal: AbortSignal) =>
      ({ provider: 'deepseek', model: 'deepseek-chat', text: `answer: ${text}` }))
    const authority = new HostControlAuthority({
      identity: {
        hostInstanceId, installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121',
        installationPublicKey: publicKey, installationPrivateKey: keys.privateKey,
        processNonce, executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1,
      },
      host, inspectModelClaimSource: inspectSource, generateModelText,
      profilePersistenceGeneration: () => 1, now: () => now,
    })
    const session = authority.openSession(ownerId, new AbortController().signal)
    const handshake = await session.handleRequest({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'host.inspect',
      params: { challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never,
        client_instance_id: clientInstanceId as never, supported_versions: [1] },
    })
    expect(handshake).toMatchObject({ type: 'result', method: 'host.inspect' })
    if (handshake.type !== 'result' || handshake.method !== 'host.inspect') throw Error('inspect failed')
    expect(handshake.result.capabilities).toContain('profile.model_claim_inventory')
    expect(handshake.result.capabilities).toContain('profile.model_text')
    await host.restoreProfile({ ...profile, ...binding, keyHandle: 'keychain:model-claim',
      unlockMaterial, ownerId })
    const opened = await host.openProfile({ ...binding, ownerId })
    const request = (): HostControlFrame => ({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'profile.model_claim_inventory',
      params: {
        client_instance_id: clientInstanceId as never, host_instance_id: hostInstanceId as never,
        process_nonce: processNonce as never, jti: randomUUID() as never, issued_at: now, expires_at: now + 1000,
        view_lease_id: opened.viewLeaseId as never, lease_generation: opened.leaseGeneration, runtime_generation: 5,
      },
    })
    const modelRequest = (): HostControlFrame => ({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'profile.model_text',
      params: {
        client_instance_id: clientInstanceId as never, host_instance_id: hostInstanceId as never,
        process_nonce: processNonce as never, jti: randomUUID() as never, issued_at: now,
        expires_at: now + 1000,
        authority_environment_id: binding.authorityEnvironmentId as never,
        account_binding_handle: binding.accountBindingHandle as never,
        authority_binding_version: binding.authorityBindingVersion, text: 'hello',
      },
    })
    expect(await session.handleRequest(modelRequest())).toMatchObject({ type: 'error',
      method: 'profile.model_text', error: { code: 'unauthorized' } })
    expect(generateModelText).not.toHaveBeenCalled()
    expect(await session.handleRequest(request())).toMatchObject({ type: 'error',
      method: 'profile.model_claim_inventory', error: { code: 'unauthorized' } })
    expect(inspectSource).not.toHaveBeenCalled()
    await host.ensureAccountProfile({ issuer: 'https://accounts.example.test', subject: 'owner',
      accountAccessToken: 'valid-token', keyHandle: 'keychain:model-claim', unlockMaterial, ...binding, ownerId })
    expect(await session.handleRequest(modelRequest())).toMatchObject({ type: 'result',
      method: 'profile.model_text', result: { state: 'complete', provider: 'deepseek',
        model: 'deepseek-chat', text: 'answer: hello' } })
    expect(generateModelText).toHaveBeenCalledWith(profile.profileId, 'hello', expect.any(AbortSignal))
    const modelOwner = randomUUID()
    const independent = authority.openSession(modelOwner, new AbortController().signal)
    expect(await independent.handleRequest({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'host.inspect',
      params: { challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never,
        client_instance_id: clientInstanceId as never, supported_versions: [1] },
    })).toMatchObject({ type: 'result', method: 'host.inspect' })
    await host.ensureAccountProfile({ issuer: 'https://accounts.example.test', subject: 'owner',
      accountAccessToken: 'valid-token', keyHandle: 'keychain:model-claim', unlockMaterial,
      ...binding, ownerId: modelOwner })
    expect(await independent.handleRequest(modelRequest())).toMatchObject({ type: 'result',
      method: 'profile.model_text', result: { state: 'complete', text: 'answer: hello' } })
    expect(host.authorizeAccountModelClaimView({ viewLeaseId: opened.viewLeaseId,
      leaseGeneration: opened.leaseGeneration, runtimeGeneration: 5, ownerId })).toBe(profile.profileId)
    independent.close()
    generateModelText.mockRejectedValueOnce(new DesktopModelWorkerError('missing_credential'))
    expect(await session.handleRequest(modelRequest())).toMatchObject({ type: 'result',
      method: 'profile.model_text', result: { state: 'rejected', code: 'missing_credential' } })
    generateModelText.mockRejectedValueOnce(new DesktopModelWorkerError('timeout'))
    expect(await session.handleRequest(modelRequest())).toMatchObject({ type: 'result',
      method: 'profile.model_text', result: { state: 'rejected', code: 'timeout' } })
    generateModelText.mockRejectedValueOnce(Error('DEEPSEEK_API_KEY=private'))
    const modelFailure = await session.handleRequest(modelRequest())
    expect(modelFailure).toMatchObject({ type: 'result', method: 'profile.model_text',
      result: { state: 'rejected', code: 'provider_failed' } })
    expect(encodeHostControlFrame(modelFailure)).not.toContain('private')
    const success = await session.handleRequest(request())
    expect(success).toMatchObject({ type: 'result', method: 'profile.model_claim_inventory', result: {
      source_digest: inventory.sourceDigest, candidates: [{ id: 'llm-deepseek:deepseek', credential: 'present' }],
    } })
    expect(encodeHostControlFrame(success)).not.toContain('valid-token')
    inspectSource.mockRejectedValueOnce(Error('DEEPSEEK_API_KEY=private'))
    const failed = await session.handleRequest(request())
    expect(failed).toMatchObject({ type: 'error', method: 'profile.model_claim_inventory',
      error: { code: 'internal_error' } })
    expect(encodeHostControlFrame(failed)).not.toContain('private')
    inspectSource.mockResolvedValueOnce({ ...inventory,
      candidates: Array.from({ length: 129 }, (_, index) => ({ ...inventory.candidates[0]!, id: `llm-pi-ai:provider-${index}` })) })
    expect(await session.handleRequest(request())).toMatchObject({ type: 'error',
      method: 'profile.model_claim_inventory', error: { code: 'unavailable' } })
    let completeRead: ((value: typeof inventory) => void) | undefined
    inspectSource.mockImplementationOnce(() => new Promise((resolve) => { completeRead = resolve }))
    const pending = session.handleRequest(request())
    await vi.waitFor(() => { expect(completeRead).toBeDefined() })
    host.revokeOwner(ownerId)
    completeRead?.(inventory)
    expect(await pending).toMatchObject({ type: 'error', method: 'profile.model_claim_inventory',
      error: { code: 'stale' } })
    expect(await session.handleRequest(modelRequest())).toMatchObject({ type: 'error',
      method: 'profile.model_text', error: { code: 'unauthorized' } })
    session.close()
  })
})
