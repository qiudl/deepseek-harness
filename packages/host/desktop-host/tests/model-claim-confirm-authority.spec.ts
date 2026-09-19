import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { encodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import type { LegacyModelClaimInventory } from '../src/legacy-migration-source.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority } from '../src/unix-transport.ts'

const candidateId = 'llm-deepseek:deepseek'
const sourceDigest = 'a'.repeat(64)
const ownerId = randomUUID()
const clientInstanceId = randomUUID()
const hostInstanceId = randomUUID()
const processNonce = 'A'.repeat(43)

interface ClaimInput {
  readonly candidateId: string
  readonly operationId: string
  readonly expectedSourceDigest: string
  authorizeAccountProfile(): string
}

describe('Host model claim confirmation', () => {
  it('requires a live Account view, fresh candidate and one-use connection authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-model-claim-confirm-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const keys = generateKeyPairSync('ed25519')
    const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(-32).toString('base64url')
    const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => 1000 } })
    const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:claim',
      authorityBindingVersion: 1 }
    const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
    const profile = await registry.registerAccount({ issuer: 'https://accounts.example.test', subject: 'person',
      keyHandle: 'keychain:claim', unlockMaterial, ...binding })
    const host = new DesktopHost({ registry, clock: { now: () => 1000 }, runtimeGeneration: 5,
      ensureProfileWorker: async () => undefined,
      verifyAccountAccessToken: (token) => {
        if (token !== 'valid-token') throw Error('invalid token')
        return { issuer: 'https://accounts.example.test', subject: 'person' }
      },
    })
    const revoke = vi.spyOn(host, 'revokeProfile')
    const inventory: LegacyModelClaimInventory = { sourceDigest, candidates: [{ id: candidateId, provider: 'deepseek',
      kind: 'llm' as const, credential: 'present' as const, sharedCredential: false }],
    unsupportedSettings: 0, unassignedCredentialReferences: 0, unassignedCredentialRecords: 0 }
    const inspectSource = vi.fn(async () => inventory)
    const claim = vi.fn(async (input: ClaimInput) => {
      expect(input.authorizeAccountProfile()).toBe(profile.profileId)
      expect(input).toMatchObject({ candidateId, expectedSourceDigest: sourceDigest })
      return { state: 'committed' as const, cleanupPending: false }
    })
    let wallTime = 1000
    const identity = { hostInstanceId, installationId: randomUUID(), installationPublicKey: publicKey,
      installationPrivateKey: keys.privateKey, processNonce, executableSignatureDigest: '1'.repeat(64),
      runtimeGeneration: 5, schemaGeneration: 1 }
    const authority = new HostControlAuthority({
      identity,
      host, inspectModelClaimSource: inspectSource, modelClaimTransaction: { claim },
      profilePersistenceGeneration: () => 1, now: () => wallTime,
    })
    const openSession = async (selected = authority, sessionOwnerId = ownerId) => {
      const session = selected.openSession(sessionOwnerId, new AbortController().signal)
      const handshake = await session.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
        method: 'host.inspect', params: { challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8' as never,
          client_instance_id: clientInstanceId as never, supported_versions: [1] } })
      expect(handshake).toMatchObject({ type: 'result', method: 'host.inspect' })
      return session
    }
    const session = await openSession()
    await host.ensureAccountProfile({ issuer: 'https://accounts.example.test', subject: 'person',
      accountAccessToken: 'valid-token', keyHandle: 'keychain:claim', unlockMaterial, ...binding, ownerId })
    const opened = await host.openProfile({ ...binding, ownerId })
    const auth = () => ({ client_instance_id: clientInstanceId as never, host_instance_id: hostInstanceId as never,
      process_nonce: processNonce as never, jti: randomUUID() as never, issued_at: wallTime,
      expires_at: wallTime + 1000 })
    const confirm = (digest = sourceDigest, selected = candidateId): HostControlFrame => ({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'profile.model_claim_confirm',
      params: { ...auth(), view_lease_id: opened.viewLeaseId as never,
        lease_generation: opened.leaseGeneration, runtime_generation: 5,
        candidate_id: selected, source_digest: digest as never },
    })
    const apply = (confirmation: string): HostControlFrame => ({ version: 1, type: 'request',
      request_id: randomUUID() as never, method: 'profile.model_claim_apply',
      params: { ...auth(), confirmation } })
    const withoutInspection = await openSession(new HostControlAuthority({ identity, host,
      modelClaimTransaction: { claim }, profilePersistenceGeneration: () => 1, now: () => wallTime }), randomUUID())
    expect(await withoutInspection.handleRequest(confirm())).toMatchObject({
      type: 'error', error: { code: 'upgrade_required' },
    })
    withoutInspection.close()
    const withoutTransaction = await openSession(new HostControlAuthority({ identity, host,
      inspectModelClaimSource: inspectSource, profilePersistenceGeneration: () => 1, now: () => wallTime }), randomUUID())
    expect(await withoutTransaction.handleRequest(confirm())).toMatchObject({
      type: 'error', error: { code: 'upgrade_required' },
    })
    expect(await withoutTransaction.handleRequest(apply('A'.repeat(43)))).toMatchObject({
      type: 'error', error: { code: 'upgrade_required' },
    })
    withoutTransaction.close()
    expect(await session.handleRequest(confirm('b'.repeat(64)))).toMatchObject({
      type: 'error', error: { code: 'conflict' },
    })
    expect(await session.handleRequest(confirm(sourceDigest, 'llm-pi-ai:missing'))).toMatchObject({
      type: 'error', error: { code: 'conflict' },
    })
    inspectSource.mockResolvedValueOnce({ ...inventory, candidates: [{ ...inventory.candidates[0]!,
      credential: 'missing' }] })
    expect(await session.handleRequest(confirm())).toMatchObject({ type: 'error', error: { code: 'conflict' } })
    inspectSource.mockResolvedValueOnce({ ...inventory, candidates: Array.from({ length: 129 },
      (_, index) => ({ ...inventory.candidates[0]!, id: `llm-pi-ai:provider-${index}` })) })
    expect(await session.handleRequest(confirm())).toMatchObject({ type: 'error', error: { code: 'unavailable' } })
    const view = vi.spyOn(host, 'authorizeAccountModelClaimView')
    view.mockReturnValueOnce(profile.profileId).mockReturnValueOnce(randomUUID() as never)
    expect(await session.handleRequest(confirm())).toMatchObject({
      type: 'error', error: { code: 'profile_mismatch' },
    })
    view.mockRestore()
    const mismatched = await session.handleRequest(confirm())
    if (mismatched.type !== 'result' || mismatched.method !== 'profile.model_claim_confirm') {
      throw Error('mismatch preflight failed')
    }
    const changedView = vi.spyOn(host, 'authorizeAccountModelClaimView')
      .mockReturnValueOnce(randomUUID() as never)
    expect(await session.handleRequest(apply(mismatched.result.confirmation)))
      .toMatchObject({ type: 'error', error: { code: 'profile_mismatch' } })
    changedView.mockRestore()
    expect(claim).not.toHaveBeenCalled()
    const confirmed = await session.handleRequest(confirm())
    expect(confirmed).toMatchObject({ type: 'result', method: 'profile.model_claim_confirm',
      result: { expires_at: 61_000 } })
    if (confirmed.type !== 'result' || confirmed.method !== 'profile.model_claim_confirm') throw Error('confirm failed')
    expect(encodeHostControlFrame(confirmed)).not.toContain('valid-token')
    expect(await (await openSession()).handleRequest(apply(confirmed.result.confirmation)))
      .toMatchObject({ type: 'error', error: { code: 'stale' } })
    for (let index = 0; index < 31; index += 1) {
      expect(await session.handleRequest(confirm())).toMatchObject({ type: 'result' })
    }
    expect(await session.handleRequest(confirm())).toMatchObject({ type: 'error', error: { code: 'busy' } })
    wallTime = 61_000
    expect(await session.handleRequest(apply(confirmed.result.confirmation)))
      .toMatchObject({ type: 'error', error: { code: 'stale' } })
    expect(claim).not.toHaveBeenCalled()
    const renewed = await session.handleRequest(confirm())
    if (renewed.type !== 'result' || renewed.method !== 'profile.model_claim_confirm') throw Error('renew failed')
    claim.mockResolvedValueOnce({ state: 'restored', cleanupPending: false } as never)
    expect(await session.handleRequest(apply(renewed.result.confirmation)))
      .toMatchObject({ type: 'error', error: { code: 'unavailable' } })
    expect(revoke).not.toHaveBeenCalled()
    const final = await session.handleRequest(confirm())
    if (final.type !== 'result' || final.method !== 'profile.model_claim_confirm') throw Error('final confirm failed')
    expect(await session.handleRequest(apply(final.result.confirmation)))
      .toMatchObject({ type: 'result', result: { state: 'committed', cleanup_pending: false } })
    expect(claim).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledWith(profile.profileId)
    expect(await session.handleRequest(apply(final.result.confirmation)))
      .toMatchObject({ type: 'error', error: { code: 'stale' } })
    session.close()
  })
})
