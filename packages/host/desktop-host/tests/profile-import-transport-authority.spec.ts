import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { HostControlFrame, ProfileImportPrepareRequest, ProfileImportPreviewRequest,
  ProfileImportStatusRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import type { ProfileImportPreview } from '../src/profile-import-preview.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority } from '../src/unix-transport.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

async function fixture(importCapabilities = true) {
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
  const status = vi.fn(async (input: { sourceProfileId: string
    targetProfileId: string
    operationOffset: number
    assertAuthority(): Promise<void> }) => {
    await input.assertAuthority()
    return { nextOperationOffset: null, operations: [{ operationId: randomUUID(), phase: 'staged' as const,
      revision: 3, sessionCount: 1, pluginCount: 0 }] }
  })
  const preview: ProfileImportPreview = {
    sourceSnapshotDigest: 'a'.repeat(64), targetSnapshotDigest: 'b'.repeat(64),
    previewDigest: 'c'.repeat(64),
    sessions: Array.from({ length: 33 }, (_, index) => ({
      source: { id: `session-${index}`, createdAt: index + 1, eventCount: 2,
        semanticDigest: 'd'.repeat(64), revision: 'v1',
        ...(index === 0 ? { parentSession: 'parent-session' } : {}) },
      ...(index === 0 ? { target: { id: 'session-0', createdAt: 1, eventCount: 2,
        semanticDigest: 'e'.repeat(64), revision: 'v2' } } : {}),
      state: index === 0 ? 'conflict' as const : 'new' as const,
    })),
    plugins: Array.from({ length: 33 }, (_, index) => ({
      source: { name: `plugin-${index}`, version: '1.0.0', sourceDigest: 'f'.repeat(64) },
      ...(index === 0 ? { target: { name: 'plugin-0', version: '2.0.0',
        sourceDigest: '0'.repeat(64) } } : {}),
      state: index === 0 ? 'conflict' as const : 'new' as const,
    })),
  }
  const inspect = vi.fn(async () => preview)
  const authority = new HostControlAuthority({ identity, host,
    ...(importCapabilities ? { prepareProfileImport: prepare, commitProfileImport: commit,
      abortProfileImport: abort, listProfileImportStatus: status, inspectProfileImport: inspect } : {}),
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
  return { session, request, grant, prepare, commit, abort, status, inspect, preview, host, old, ownerId }
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

it('maps import changes and invalid selections to actionable protocol errors', async () => {
  const f = await fixture()
  await f.grant()
  const cases = [
    ['profile_import_inventory_changed', 'stale'],
    ['profile_import_selection_invalid', 'invalid_frame'],
    ['profile_import_plugin_publish_changed', 'profile_integrity_failed'],
  ] as const
  for (const [failure, code] of cases) {
    f.prepare.mockRejectedValueOnce(Error(failure))
    expect(await f.session.handleRequest(f.request())).toMatchObject({
      type: 'error', error: { code },
    })
  }
  expect(f.prepare).toHaveBeenCalledTimes(cases.length)
})

it('returns import status only while both identities remain authorized', async () => {
  const f = await fixture()
  const prepare = f.request()
  const { operation_id: _operation, expected_preview_digest: _digest,
    selected_session_ids: _sessions, selected_plugin_names: _plugins, ...params } = prepare.params
  const request = (): ProfileImportStatusRequest => ({ version: 1, type: 'request',
    request_id: randomUUID() as never, method: 'profile.import_status',
    params: { ...params, jti: randomUUID() as never, operation_offset: 0 } })
  expect(await f.session.handleRequest(request()))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  expect(f.status).not.toHaveBeenCalled()
  const target = await f.grant()
  expect(await f.session.handleRequest(request())).toMatchObject({ type: 'result',
    result: { next_operation_offset: null, operations: [{ phase: 'staged', revision: 3,
      session_count: 1, plugin_count: 0 }] } })
  expect(f.status).toHaveBeenCalledWith(expect.objectContaining({ sourceProfileId: f.old.profileId,
    targetProfileId: target.profileId, operationOffset: 0 }))
  f.status.mockImplementationOnce(async () => {
    f.host.revokeOwner(f.ownerId)
    return { nextOperationOffset: null, operations: [] }
  })
  expect(await f.session.handleRequest(request()))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
})

it('pages a verified preview without exposing content and rejects stale or revoked authority', async () => {
  const f = await fixture()
  const prepare = f.request()
  const { operation_id: _operation, expected_preview_digest: _digest,
    selected_session_ids: _sessions, selected_plugin_names: _plugins, ...base } = prepare.params
  const request = (sessionOffset: number, pluginOffset: number,
    expectedDigest?: string): ProfileImportPreviewRequest => ({
    version: 1, type: 'request', request_id: randomUUID() as never, method: 'profile.import_preview',
    params: { ...base, jti: randomUUID() as never, session_offset: sessionOffset,
      plugin_offset: pluginOffset,
      ...(expectedDigest ? { expected_preview_digest: expectedDigest as never } : {}) },
  })
  expect(await f.session.handleRequest(request(0, 0)))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  expect(f.inspect).not.toHaveBeenCalled()
  await f.grant()
  const first = await f.session.handleRequest(request(0, 0))
  expect(first).toMatchObject({ type: 'result', method: 'profile.import_preview', result: {
    session_count: 33, plugin_count: 33, next_session_offset: 32, next_plugin_offset: 32,
  } })
  if (first.type !== 'result' || first.method !== 'profile.import_preview') throw Error('preview_missing')
  expect(first.result.sessions).toHaveLength(32)
  expect(first.result.plugins).toHaveLength(32)
  expect(first.result.sessions[0]).toMatchObject({ id: 'session-0', parent_session: 'parent-session',
    state: 'conflict', target_digest: 'e'.repeat(64) })
  expect(first.result.plugins[0]).toMatchObject({ name: 'plugin-0', state: 'conflict',
    target_version: '2.0.0', target_digest: '0'.repeat(64) })
  expect(JSON.stringify(first)).not.toContain(prepare.params.source_unlock_material)
  const last = await f.session.handleRequest(request(32, 32, f.preview.previewDigest))
  expect(last).toMatchObject({ type: 'result', result: {
    next_session_offset: null, next_plugin_offset: null,
  } })
  if (last.type !== 'result' || last.method !== 'profile.import_preview') throw Error('preview_missing')
  expect(last.result.sessions).toEqual([expect.objectContaining({ id: 'session-32', state: 'new' })])
  expect(last.result.plugins).toEqual([expect.objectContaining({ name: 'plugin-32', state: 'new' })])
  expect(await f.session.handleRequest(request(0, 0, '1'.repeat(64))))
    .toMatchObject({ type: 'error', error: { code: 'stale' } })
  expect(await f.session.handleRequest(request(34, 0)))
    .toMatchObject({ type: 'error', error: { code: 'invalid_frame' } })
  f.inspect.mockImplementationOnce(async () => {
    f.host.revokeOwner(f.ownerId)
    return f.preview
  })
  expect(await f.session.handleRequest(request(0, 0)))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
})

it('maps changed and unreadable old inventory to distinct preview errors', async () => {
  const f = await fixture()
  const { operation_id: _operation, expected_preview_digest: _digest,
    selected_session_ids: _sessions, selected_plugin_names: _plugins, ...base } = f.request().params
  await f.grant()
  const cases = [
    ['profile_import_inventory_changed', 'stale'],
    ['profile_import_schema_unsupported', 'schema_unsupported'],
    ['profile_import_inventory_invalid', 'profile_integrity_failed'],
  ] as const
  for (const [failure, code] of cases) {
    f.inspect.mockRejectedValueOnce(Error(failure))
    const request: ProfileImportPreviewRequest = { version: 1, type: 'request',
      request_id: randomUUID() as never, method: 'profile.import_preview',
      params: { ...base, jti: randomUUID() as never, session_offset: 0, plugin_offset: 0 } }
    expect(await f.session.handleRequest(request)).toMatchObject({ type: 'error', error: { code } })
  }
  expect(f.inspect).toHaveBeenCalledTimes(cases.length)
})

it('reports upgrade_required for every import command on a Host without import capabilities', async () => {
  const f = await fixture(false)
  await f.grant()
  const prepare = f.request()
  const { operation_id: _operation, expected_preview_digest: _digest,
    selected_session_ids: _sessions, selected_plugin_names: _plugins, ...base } = prepare.params
  const requests: HostControlFrame[] = [
    prepare,
    { ...prepare, request_id: randomUUID() as never, method: 'profile.import_commit',
      params: { ...base, jti: randomUUID() as never, operation_id: prepare.params.operation_id } },
    { ...prepare, request_id: randomUUID() as never, method: 'profile.import_abort',
      params: { ...base, jti: randomUUID() as never, operation_id: prepare.params.operation_id } },
    { ...prepare, request_id: randomUUID() as never, method: 'profile.import_status',
      params: { ...base, jti: randomUUID() as never, operation_offset: 0 } },
    { ...prepare, request_id: randomUUID() as never, method: 'profile.import_preview',
      params: { ...base, jti: randomUUID() as never, session_offset: 0, plugin_offset: 0 } },
  ]
  for (const request of requests) {
    expect(await f.session.handleRequest(request))
      .toMatchObject({ type: 'error', error: { code: 'upgrade_required' } })
  }
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.abort).not.toHaveBeenCalled()
  expect(f.status).not.toHaveBeenCalled()
  expect(f.inspect).not.toHaveBeenCalled()
})

it('rejects import status, preparation, and preview when the authorized Profile pair changes', async () => {
  for (const method of ['profile.import_status', 'profile.import_prepare', 'profile.import_preview'] as const) {
    const f = await fixture()
    await f.grant()
    const authorize = f.host.authorizeSlarkImportPreview.bind(f.host)
    const spy = vi.spyOn(f.host, 'authorizeSlarkImportPreview')
      .mockImplementationOnce(input => authorize(input))
      .mockImplementationOnce(input => ({ ...authorize(input), targetProfileId: f.old.profileId }))
    const prepare = f.request()
    const { operation_id: _operation, expected_preview_digest: _digest,
      selected_session_ids: _sessions, selected_plugin_names: _plugins, ...base } = prepare.params
    const request: HostControlFrame = method === 'profile.import_prepare' ? prepare
      : method === 'profile.import_status'
        ? { ...prepare, method, params: { ...base, jti: randomUUID() as never, operation_offset: 0 } }
        : { ...prepare, method, params: { ...base, jti: randomUUID() as never,
          session_offset: 0, plugin_offset: 0 } }
    expect(await f.session.handleRequest(request))
      .toMatchObject({ type: 'error', error: { code: 'stale' } })
    spy.mockRestore()
  }
})
