import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { HostControlFrame, ProfileImportPrepareRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority } from '../src/unix-transport.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-import-transport-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const clock = { now: () => 1000 }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock,
    ...registryFileFixture() })
  const issuer = 'https://accounts.dsh.example.com'
  const subject = randomUUID()
  const environmentId = randomUUID()
  const ownerId = randomUUID()
  const oldUnlock = Buffer.alloc(32, 9).toString('base64url')
  const old = await registry.registerAccount({ issuer, subject, keyHandle: 'keychain:old', unlockMaterial: oldUnlock })
  const expected = { slarkUserId: 'user', environmentId, profileId: randomUUID(), deviceId: randomUUID(),
    deviceKeyThumbprint: Buffer.alloc(32, 4).toString('base64url'), loginEpoch: 2, bindingEpoch: 3 }
  const binding = { authorityEnvironmentId: environmentId,
    accountBindingHandle: `slark:${expected.profileId}`, authorityBindingVersion: 3 }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
    verifySlarkAccountAccessToken: () => ({ issuer, subject, bindingScope: 'a'.repeat(64) }),
    ensureProfileWorker: async () => undefined })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: Buffer.alloc(32, 8).toString('base64url'),
    executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const prepare = vi.fn(async (input: { operationId: string; assertAuthority(): Promise<void> }) => {
    await input.assertAuthority()
    return { operationId: input.operationId, phase: 'staged' as const }
  })
  const commit = vi.fn(async (input: { operationId: string; assertAuthority(): Promise<void> }) => {
    await input.assertAuthority()
    return { operationId: input.operationId, phase: 'committed' as const }
  })
  const abort = vi.fn(async (input: { operationId: string; assertAuthority(): Promise<void> }) => {
    await input.assertAuthority()
    return { operationId: input.operationId, phase: 'aborted' as const }
  })
  const authority = new HostControlAuthority({ identity, host, prepareProfileImport: prepare,
    commitProfileImport: commit, abortProfileImport: abort,
    profilePersistenceGeneration: () => 1, now: clock.now })
  const session = authority.openSession(ownerId, new AbortController().signal)
  onTestFinished(() => { session.close() })
  const clientInstanceId = randomUUID()
  await session.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never,
    method: 'host.inspect', params: { challenge: Buffer.alloc(32, 1).toString('base64url') as never,
      client_instance_id: clientInstanceId as never, supported_versions: [1] } })
  const base = { client_instance_id: clientInstanceId as never,
    host_instance_id: identity.hostInstanceId as never, process_nonce: identity.processNonce as never,
    issued_at: 1000, expires_at: 2000, authority_environment_id: environmentId as never,
    account_binding_handle: binding.accountBindingHandle as never, authority_binding_version: 3,
    account_issuer: issuer, account_subject: subject, source_account_issuer: issuer,
    source_account_subject: subject, source_profile_key_handle: 'keychain:old',
    source_unlock_material: oldUnlock, operation_id: randomUUID(),
    expected_preview_digest: 'a'.repeat(64) as never,
    selected_session_ids: ['source-session'], selected_plugin_names: [] }
  const request = (): ProfileImportPrepareRequest => ({ version: 1, type: 'request',
    request_id: randomUUID() as never, method: 'profile.import_prepare',
    params: { ...base, jti: randomUUID() as never } })
  const grant = () => host.ensureSlarkAccountProfile({ ...binding, issuer, subject,
    accountAccessToken: 'slark-token', keyHandle: 'keychain:slark',
    unlockMaterial: Buffer.alloc(32, 5).toString('base64url'), ownerId, expected })
  return { session, request, grant, prepare, commit, abort, host, old, ownerId }
}

it('requires both current Slark grant and old Account unlock proof before preparing an import', async () => {
  const f = await fixture()
  expect(await f.session.handleRequest(f.request())).toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  expect(f.prepare).not.toHaveBeenCalled()
  const target = await f.grant()
  const wrong = f.request()
  expect(await f.session.handleRequest({ ...wrong, params: { ...wrong.params,
    source_unlock_material: Buffer.alloc(32, 8).toString('base64url') } }))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  expect(f.prepare).not.toHaveBeenCalled()
  expect(await f.session.handleRequest(f.request())).toMatchObject({ type: 'result',
    method: 'profile.import_prepare', result: { phase: 'staged' } })
  expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ sourceProfileId: f.old.profileId,
    targetProfileId: target.profileId, selectedSessionIds: ['source-session'] }))
})

it('does not report success after the owning Slark grant is revoked during preparation', async () => {
  const f = await fixture()
  await f.grant()
  f.prepare.mockImplementationOnce(async (input) => {
    f.host.revokeOwner(f.ownerId)
    return { operationId: input.operationId, phase: 'staged' as const }
  })
  const result: HostControlFrame = await f.session.handleRequest(f.request())
  expect(result).toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
})

it('rechecks both identities on explicit commit and abort', async () => {
  const f = await fixture()
  const prepare = f.request()
  const { expected_preview_digest: _digest, selected_session_ids: _sessions,
    selected_plugin_names: _plugins, ...params } = prepare.params
  const commit: HostControlFrame = { ...prepare, method: 'profile.import_commit', params }
  expect(await f.session.handleRequest(commit)).toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  await f.grant()
  expect(await f.session.handleRequest({ ...commit, request_id: randomUUID() as never,
    params: { ...params, jti: randomUUID() as never } })).toMatchObject({ type: 'result', result: { phase: 'committed' } })
  const abort: HostControlFrame = { ...prepare, request_id: randomUUID() as never,
    method: 'profile.import_abort', params: { ...params, jti: randomUUID() as never } }
  expect(await f.session.handleRequest(abort)).toMatchObject({ type: 'result', result: { phase: 'aborted' } })
  expect(f.commit).toHaveBeenCalledOnce()
  expect(f.abort).toHaveBeenCalledOnce()
})
