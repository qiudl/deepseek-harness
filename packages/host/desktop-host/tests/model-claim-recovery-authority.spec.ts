import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { encodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority } from '../src/unix-transport.ts'

const now = 1_000
const ownerId = randomUUID()
const clientInstanceId = randomUUID()
const hostInstanceId = randomUUID()
const processNonce = 'A'.repeat(43)
const candidateId = 'llm-deepseek:deepseek'
const operationId = randomUUID()
const sourceDigest = 'a'.repeat(64)
const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
type RecoveryMethod = 'profile.model_claim_recovery_status' | 'profile.model_claim_restore' | 'profile.model_claim_retry'

interface RestoreInput {
  readonly candidateId: string
  readonly operationId: string
  authorizeAccountProfile(): string
}

interface RetryInput extends RestoreInput {
  readonly expectedSourceDigest: string
}

describe('Host model claim recovery authority', () => {
  it('uses fresh Account proof without a worker and returns only same-Profile redacted receipts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-model-claim-recovery-authority-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const keys = generateKeyPairSync('ed25519')
    const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(-32).toString('base64url')
    const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => now } })
    const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:person',
      authorityBindingVersion: 1 }
    const profile = await registry.registerAccount({ issuer: 'https://accounts.example.test', subject: 'person',
      keyHandle: 'keychain:person', unlockMaterial, ...binding })
    let tokenValid = true
    const host = new DesktopHost({ registry, clock: { now: () => now }, runtimeGeneration: 5,
      verifyAccountAccessToken: (token) => {
        if (token !== 'valid-token' || !tokenValid) throw Error('expired token')
        return { issuer: 'https://accounts.example.test', subject: 'person' }
      },
      ensureProfileWorker: async () => { throw Error('pending marker') },
    })
    const revoke = vi.spyOn(host, 'revokeProfile')
    const status = vi.fn((input: { candidateId: string; authorizeAccountProfile(): string }) => {
      expect(input.authorizeAccountProfile()).toBe(profile.profileId)
      return { candidateId, operationId, sourceDigest, status: 'pending' as const }
    })
    const restore = vi.fn(async (input: RestoreInput) => {
      expect(input.authorizeAccountProfile()).toBe(profile.profileId)
      return { state: 'restored' as const, cleanupPending: false }
    })
    const retry = vi.fn(async (input: RetryInput) => {
      expect(input.authorizeAccountProfile()).toBe(profile.profileId)
      expect(input.expectedSourceDigest).toBe(sourceDigest)
      return { state: 'committed' as const, cleanupPending: false }
    })
    const authority = new HostControlAuthority({
      identity: { hostInstanceId, installationId: randomUUID(), installationPublicKey: publicKey,
        installationPrivateKey: keys.privateKey, processNonce, executableSignatureDigest: '1'.repeat(64),
        runtimeGeneration: 5, schemaGeneration: 1 },
      host, modelClaimRecovery: { status, restore },
      modelClaimTransaction: { claim: vi.fn(), retry },
      inspectModelClaimSource: async () => { throw Error('retry does not inspect inventory') },
      profilePersistenceGeneration: () => 1, now: () => now,
    })
    const session = authority.openSession(ownerId, new AbortController().signal)
    const handshake = await session.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
      method: 'host.inspect', params: { challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never,
        client_instance_id: clientInstanceId as never, supported_versions: [1] } })
    if (handshake.type !== 'result' || handshake.method !== 'host.inspect') throw Error('inspect failed')
    expect(handshake.result.capabilities).toContain('profile.model_claim_recovery_status')
    expect(handshake.result.capabilities).toContain('profile.model_claim_restore')
    expect(handshake.result.capabilities).toContain('profile.model_claim_retry')
    const proof = () => ({
      client_instance_id: clientInstanceId as never, host_instance_id: hostInstanceId as never,
      process_nonce: processNonce as never, jti: randomUUID() as never, issued_at: now, expires_at: now + 1_000,
      account_access_token: 'valid-token', account_issuer: 'https://accounts.example.test',
      account_subject: 'person', authority_environment_id: binding.authorityEnvironmentId as never,
      account_binding_handle: binding.accountBindingHandle, authority_binding_version: 1,
      profile_key_handle: 'keychain:person', profile_unlock_material: unlockMaterial,
      candidate_id: candidateId,
    })
    const request = (method: RecoveryMethod, params = proof()): HostControlFrame => ({
      version: 1, type: 'request', request_id: randomUUID() as never,
      method, params: { ...params,
        ...(method === 'profile.model_claim_recovery_status' ? {} : { operation_id: operationId }),
        ...(method === 'profile.model_claim_retry' ? { source_digest: sourceDigest as never } : {}) },
    } as HostControlFrame)
    const found = await session.handleRequest(request('profile.model_claim_recovery_status'))
    expect(found).toMatchObject({ type: 'result', result: {
      state: 'pending', candidate_id: candidateId, operation_id: operationId, source_digest: sourceDigest,
    } })
    expect(encodeHostControlFrame(found)).not.toContain('valid-token')
    expect(revoke).not.toHaveBeenCalled()
    status.mockReturnValueOnce(null as never)
    expect(await session.handleRequest(request('profile.model_claim_recovery_status')))
      .toMatchObject({ type: 'result', result: { state: 'unclaimed' } })
    restore.mockResolvedValueOnce({ state: 'committed', cleanupPending: false } as never)
    expect(await session.handleRequest(request('profile.model_claim_restore')))
      .toMatchObject({ type: 'error', error: { code: 'unavailable' } })
    expect(revoke).not.toHaveBeenCalled()
    expect(await session.handleRequest(request('profile.model_claim_restore')))
      .toMatchObject({ type: 'result', result: { state: 'restored', cleanup_pending: false } })
    expect(revoke).toHaveBeenCalledWith(profile.profileId)
    expect(status).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledTimes(2)
    retry.mockResolvedValueOnce({ state: 'restored', cleanupPending: false } as never)
    expect(await session.handleRequest(request('profile.model_claim_retry')))
      .toMatchObject({ type: 'error', error: { code: 'unavailable' } })
    expect(await session.handleRequest(request('profile.model_claim_retry')))
      .toMatchObject({ type: 'result', result: { state: 'committed', cleanup_pending: false } })
    expect(retry).toHaveBeenCalledTimes(2)
    tokenValid = false
    expect(await session.handleRequest(request('profile.model_claim_recovery_status')))
      .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
    expect(await session.handleRequest(request('profile.model_claim_restore')))
      .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
    expect(await session.handleRequest(request('profile.model_claim_retry')))
      .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
    session.close()

    const disabled = new HostControlAuthority({
      identity: { hostInstanceId, installationId: randomUUID(), installationPublicKey: publicKey,
        installationPrivateKey: keys.privateKey, processNonce, executableSignatureDigest: '1'.repeat(64),
        runtimeGeneration: 5, schemaGeneration: 1 },
      host, profilePersistenceGeneration: () => 1, now: () => now,
    }).openSession(ownerId, new AbortController().signal)
    await disabled.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
      method: 'host.inspect', params: { challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never,
        client_instance_id: clientInstanceId as never, supported_versions: [1] } })
    expect(await disabled.handleRequest(request('profile.model_claim_recovery_status')))
      .toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
    expect(await disabled.handleRequest(request('profile.model_claim_retry')))
      .toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
    disabled.close()

    const noRetry = new HostControlAuthority({
      identity: { hostInstanceId, installationId: randomUUID(), installationPublicKey: publicKey,
        installationPrivateKey: keys.privateKey, processNonce, executableSignatureDigest: '1'.repeat(64),
        runtimeGeneration: 5, schemaGeneration: 1 },
      host, modelClaimRecovery: { status, restore }, profilePersistenceGeneration: () => 1, now: () => now,
    }).openSession(randomUUID(), new AbortController().signal)
    await noRetry.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
      method: 'host.inspect', params: { challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never,
        client_instance_id: clientInstanceId as never, supported_versions: [1] } })
    expect(await noRetry.handleRequest(request('profile.model_claim_retry')))
      .toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
    noRetry.close()
  })
})
