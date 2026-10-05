import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'

const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:selection', authorityBindingVersion: 1 }
const target = { workspace_id: randomUUID() as never, session_id: 'session' as never }
const choice = { ...target, provider: 'p', model: 'm' }

async function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-selection-authority-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const clock = { now: () => 1000 }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock })
  const account = { issuer: 'https://accounts.example.test', subject: 'owner', keyHandle: 'keychain:selection',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ...binding }
  const profile = await registry.registerAccount(account)
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (token) => {
      if (token !== 'valid-token') throw Error('invalid')
      return { issuer: account.issuer, subject: account.subject }
    },
  })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 5, schemaGeneration: 1 }
  const inspectWorkspaceModelSelection = vi.fn(async () => choice)
  const authority = new HostControlAuthority({ identity, host, ...(enabled ? { inspectWorkspaceModelSelection } : {}),
    profilePersistenceGeneration: () => 1, now: clock.now })
  const ownerId = randomUUID()
  const lifetime = new AbortController()
  const session = authority.openSession(ownerId, lifetime.signal)
  const seen: HostControlFrame[] = []
  let alter: ((frame: HostControlFrame) => HostControlFrame) | undefined
  const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: identity.installationId,
    trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: clock.now },
  { call: async (frame) => {
    seen.push(frame)
    const result = await session.handleRequest(frame)
    return alter ? alter(result) : result
  }, isConnected: () => !lifetime.signal.aborted,
  close: () => { lifetime.abort(); session.close() } })
  onTestFinished(() => { client.close() })
  const grant = () => host.ensureAccountProfile({ ...account, accountAccessToken: 'valid-token', ownerId })
  return { host, account, profile, ownerId, client, inspectWorkspaceModelSelection, grant, seen, session, identity, authority,
    alter: (callback: typeof alter) => { alter = callback } }
}

it('refuses a valid result frame for another method after the authorized model-selection read', async () => {
  const f = await fixture(); await f.grant()
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.workspace_model_selection'
    ? { ...frame, method: 'profile.collaboration_analysis', result: { kind: 'output', json_base64url: 'e30' } } : frame)
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, ...target }))
    .rejects.toMatchObject({ code: 'unavailable' })
  expect(f.inspectWorkspaceModelSelection).toHaveBeenCalledOnce()
})

it('requires a verified Account on this connection and returns the worker-selected choice', async () => {
  const f = await fixture()
  await f.host.restoreProfile({ ...f.profile, ...f.account, ownerId: f.ownerId })
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, ...target }))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.inspectWorkspaceModelSelection).not.toHaveBeenCalled()
  await f.grant()
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, ...target })).resolves.toEqual(choice)
  expect(f.inspectWorkspaceModelSelection).toHaveBeenCalledWith(f.profile.profileId, target, expect.any(AbortSignal))
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, authorityEnvironmentId: randomUUID(), ...target }))
    .rejects.toMatchObject({ code: 'unauthorized' })
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, authorityBindingVersion: 2, ...target }))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.inspectWorkspaceModelSelection).toHaveBeenCalledOnce()
})

it('rechecks revocation before releasing a completed worker read', async () => {
  const f = await fixture()
  await f.grant()
  f.inspectWorkspaceModelSelection.mockImplementationOnce(async () => {
    f.host.revokeOwner(f.ownerId)
    return choice
  })
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, ...target }))
    .rejects.toMatchObject({ code: 'unauthorized' })
})

it('rejects wrong-target and secret-bearing worker replies', async () => {
  const f = await fixture()
  await f.grant()
  f.inspectWorkspaceModelSelection.mockResolvedValueOnce({ ...choice, session_id: 'other' as never })
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, ...target }))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
  f.inspectWorkspaceModelSelection.mockResolvedValueOnce({ ...choice, api_key: 'private' } as typeof choice)
  await expect(f.client.inspectWorkspaceModelSelection({ ...binding, ...target })).rejects.toThrow()
})


it('negotiates absence without sending a read and rejects forged epoch and replayed requests', async () => {
  const old = await fixture(false)
  const count = old.seen.length
  await expect(old.client.inspectWorkspaceModelSelection({ ...binding, ...target }))
    .rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.seen.length).toBe(count)
  const f = await fixture()
  await f.grant()
  await f.client.inspectWorkspaceModelSelection({ ...binding, ...target })
  const request = f.seen.at(-1)!
  expect(await f.session.handleRequest(request)).toMatchObject({ type: 'error', error: { code: 'replayed' } })
  if (request.type !== 'request' || request.method !== 'profile.workspace_model_selection') throw Error('missing read')
  expect(await f.session.handleRequest({ ...request, request_id: randomUUID() as never,
    params: { ...request.params, jti: randomUUID() as never, process_nonce: Buffer.alloc(32, 3).toString('base64url') as never } }))
    .toMatchObject({ type: 'error', error: { code: 'stale' } })
  const other = f.authority.openSession(randomUUID(), new AbortController().signal)
  onTestFinished(() => { other.close() })
  await other.handleRequest({ version: 1, type: 'request', request_id: randomUUID() as never, method: 'host.inspect',
    params: { challenge: Buffer.alloc(32, 3).toString('base64url') as never, client_instance_id: request.params.client_instance_id, supported_versions: [1] } })
  expect(await other.handleRequest({ ...request, request_id: randomUUID() as never,
    params: { ...request.params, jti: randomUUID() as never } }))
    .toMatchObject({ type: 'error', error: { code: 'unauthorized' } })
  expect(f.inspectWorkspaceModelSelection).toHaveBeenCalledOnce()
})
