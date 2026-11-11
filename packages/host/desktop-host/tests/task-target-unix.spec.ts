/** Real Unix/Account/signing component; the worker descriptor is controlled, not an installed Bot or execution proof. */
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { captureHostTaskTargetCall, encodeHostTaskTargetDescriptor, encodeHostTaskTargetPrepareDirective,
  hostTaskCoordinationScopeDigest, hostTaskCoordinationFloorDigest, hostTaskTargetOriginalStepHash,
  hostTaskTargetDescriptorDigest, hostTaskTargetProviderDigest, parseHostRemoteSessionJson,
  parseHostRuntimeEntryOriginsConfiguration, parseHostTaskCoordinationScope, parseHostTaskTargetDescriptor,
  parseHostTaskTargetPrepareDirective, type HostTaskTargetDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import { rootWorkerOperations } from '../src/root-worker-operations.ts'
import { UnixHostClient, UnixHostServer, type UnixHostServerOptions } from '../src/unix-transport.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

const vectorJson: unknown = JSON.parse(readFileSync(new URL('../../control-protocol/tests/fixtures/task-target-v1.json', import.meta.url), 'utf8'))
if (!vectorJson || typeof vectorJson !== 'object' || Array.isArray(vectorJson)) throw Error('invalid controlled fixture')
const vectors = vectorJson as Record<string, unknown>
type Missing = 'configuration' | 'policy' | 'receiver' | 'analysis'
async function fixture(missing?: Missing) {
  const root = mkdtempSync(join(tmpdir(), 'paired-uds-')), uid = process.getuid!()
  const prepareTemplate = parseHostTaskTargetPrepareDirective(vectors.prepare)
  const clock = { now: () => prepareTemplate.issuedAt + 1 }
  const ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: 'A'.repeat(43) })
  onTestFinished(async () => { try { await ownership.release() } finally { rmSync(root, { recursive: true, force: true }) } })
  const registry = new ProfileRegistry({ root: join(root, 'registry'), clock, deviceIndexKey: Buffer.alloc(32, 7), ...registryFileFixture() })
  const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:paired', authorityBindingVersion: 1,
    issuer: 'https://accounts.example.test', subject: randomUUID(), keyHandle: 'keychain:paired',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), accountAccessToken: 'controlled-token' }
  const keys = generateKeyPairSync('ed25519'), cloud = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const configuration = parseHostRuntimeEntryOriginsConfiguration({ schemaVersion: 3, implementationDigest: 'a'.repeat(64),
    compositionDigest: 'b'.repeat(64), manifest: { path: join(root, 'native-origins/owners-v3.json'), sha256: 'c'.repeat(64) } })
  const workerId = randomUUID(), actions: string[] = []
  let profileId = '', replace = false, descriptor: HostTaskTargetDescriptor | undefined
  const workers = new ProfileWorkerSupervisor(async () => ({ workerId, closeNotifications() {}, abort() {}, done: Promise.resolve(),
    async collaborationAnalysis(command, signal) {
      signal.throwIfAborted()
      if (!command || typeof command !== 'object' || Array.isArray(command) || !('action' in command) || typeof command.action !== 'string' || !('request' in command)) throw Error('missing private paired call')
      const call = captureHostTaskTargetCall(command.request)
      if (call.operation !== 'prepare') throw Error('only controlled prepare is supported')
      expect(command.actualWorkerId).toBe(workerId)
      expect(command.actualAccount).toMatchObject({ hostProfileId: profileId, accountBindingId: account.accountBindingHandle })
      actions.push(command.action)
      if (replace) await workers.dispose(profileId)
      if (command.action === 'task_target') {
        const template = parseHostTaskTargetDescriptor(vectors.descriptor), d = call.directive
        const draft = { ...template, scope: d.scope, peer: d.peer, transfer: d.transfer,
          issuer: account.issuer, keyId: identity.installationId,
          originalStepHash: hostTaskTargetOriginalStepHash(d.originalStep), preparedAt: clock.now(), signature: 'A'.repeat(86),
          target: { ...template.target, hostProfileId: profileId, workerId,
            providerDigest: hostTaskTargetProviderDigest(configuration.implementationDigest, configuration.compositionDigest) } }
        descriptor = parseHostTaskTargetDescriptor({ ...draft, descriptorDigest: hostTaskTargetDescriptorDigest(draft) })
      } else if (command.action === 'task_target_commit') {
        if (!descriptor || !('signed' in command) || !command.signed || typeof command.signed !== 'object'
          || !('kind' in command.signed) || command.signed.kind !== 'descriptor' || !('value' in command.signed)) throw Error('missing signed descriptor')
        const signed = parseHostTaskTargetDescriptor(command.signed.value)
        expect(encodeHostTaskTargetDescriptor(signed)).toBe(encodeHostTaskTargetDescriptor(descriptor))
        expect(verify(null, Buffer.from(encodeHostTaskTargetDescriptor(signed)), keys.publicKey, Buffer.from(signed.signature, 'base64url'))).toBe(true)
        descriptor = signed
      } else throw Error('unexpected private action')
      return parseHostRemoteSessionJson({ kind: 'task_target', record: { ok: true, peer: call.directive.peer, record: { status: 'prepared', descriptor } } })
    } }))
  onTestFinished(() => workers.disposeAll())
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
    ensureProfileWorker: async (profile) => { await workers.ensure({ profileId: profile.profileId, profileRoot: join(root, 'worker'), credentialHandle: profile.keyHandle, pluginRoots: [] }) },
    verifyAccountAccessToken: (token) => { if (token !== account.accountAccessToken) throw Error('invalid controlled token'); return { issuer: account.issuer, subject: account.subject } } })
  const attestPeer = async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest })
  const options: { -readonly [K in keyof UnixHostServerOptions]: UnixHostServerOptions[K] } = {
    socketPath: join(root, 'host.sock'), ownership, expectedUid: uid, attestPeer,
    allowedDesktopExecutableDigests: new Set([identity.executableSignatureDigest]), identity, host, profilePersistenceGeneration: () => 1,
    now: clock.now, ...rootWorkerOperations(workers), runtimeEntryOrigins: configuration,
    collaborationAnalysis: workers.collaborationAnalysis.bind(workers),
    taskCoordinationEnvironments: [{ audience: 'urn:slark:task-coordination:v1', environmentKey: prepareTemplate.scope.environmentKey,
      keyring: { version: 1, issuer: prepareTemplate.issuer, environmentId: account.authorityEnvironmentId,
        keys: [{ kid: prepareTemplate.keyId, publicKeyPem: cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString(), validFrom: 1, validUntil: prepareTemplate.expiresAt + 1 }] } }],
    taskCoordinationReceiver: selected => workers.taskCoordinationReceiver(selected),
  }
  const remove = (field: Missing) => {
    if (field === 'configuration') delete options.runtimeEntryOrigins
    if (field === 'policy') options.taskCoordinationEnvironments = []
    if (field === 'receiver') delete options.taskCoordinationReceiver
    if (field === 'analysis') delete options.collaborationAnalysis
  }
  if (missing) remove(missing)
  const server = new UnixHostServer(options); onTestFinished(() => server.close()); await server.start()
  const client = await UnixHostClient.connect({ socketPath: options.socketPath, expectedUid: uid, attestPeer,
    trustedInstallationId: identity.installationId, trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: clock.now })
  onTestFinished(() => { client.close() })
  const ready = await client.ensureAccountProfile(account); profileId = ready.profileId
  const scope = parseHostTaskCoordinationScope({ ...prepareTemplate.scope, authorityEnvironmentId: account.authorityEnvironmentId,
    accountIssuer: account.issuer, accountSubject: account.subject, hostProfileId: profileId })
  const draft = { ...prepareTemplate, scope, scopeDigest: hostTaskCoordinationScopeDigest(scope),
    floorDigest: hostTaskCoordinationFloorDigest(scope),
    peer: { ...prepareTemplate.peer, installationId: identity.installationId, publicKey,
      hostInstanceId: identity.hostInstanceId, processNonce: identity.processNonce },
    accountBindingId: account.accountBindingHandle, accountBindingVersion: account.authorityBindingVersion }
  const directive = parseHostTaskTargetPrepareDirective({ ...draft, signature: sign(null, Buffer.from(encodeHostTaskTargetPrepareDirective(draft)), cloud.privateKey).toString('base64url') })
  const request = captureHostTaskTargetCall({ operation: 'prepare', directive })
  return { client, account, request, actions, keys, remove, retained: () => descriptor, replaceWorker: () => { replace = true } }
}

it.skipIf(process.platform === 'win32')('advertises the paired protocol only with its actual facilities and signs the original Unix prepare', async () => {
  const f = await fixture()
  const result = await f.client.operateTaskTarget({ ...f.account, request: f.request })
  expect(f.client.inspection.capabilities).toContain('profile.task_target_v1')
  if (!result.ok || result.record.status !== 'prepared') throw Error('missing prepared component result')
  expect(f.actions).toEqual(['task_target', 'task_target_commit'])
  expect(result.record.descriptor).toEqual(f.retained())
  expect(result.record.descriptor.signature).not.toBe('A'.repeat(86))
  expect(verify(null, Buffer.from(encodeHostTaskTargetDescriptor(result.record.descriptor)), f.keys.publicKey,
    Buffer.from(result.record.descriptor.signature, 'base64url'))).toBe(true)
})
it.skipIf(process.platform === 'win32')('retains Main nonce refusal after a successful prepare', async () => {
  const f = await fixture()
  await f.client.operateTaskTarget({ ...f.account, request: f.request })
  await expect(f.client.operateTaskTarget({ ...f.account, request: f.request })).rejects.toMatchObject({ code: 'replayed' })
  expect(f.actions).toEqual(['task_target', 'task_target_commit'])
})
it.skipIf(process.platform === 'win32').each(['configuration', 'policy', 'receiver', 'analysis'] as const)('does not advertise or dispatch with missing %s', async (missing) => {
  const f = await fixture(missing)
  expect(f.client.inspection.capabilities).not.toContain('profile.task_target_v1')
  await expect(f.client.operateTaskTarget({ ...f.account, request: f.request })).rejects.toMatchObject({ code: 'upgrade_required' })
  await expect(f.client.collaborationAnalysis({ ...f.account, command: { action: 'task_target', request: f.request } })).rejects.toThrow()
  expect(f.actions).toEqual([])
})
it.skipIf(process.platform === 'win32').each(['configuration', 'policy', 'receiver', 'analysis'] as const)('rechecks missing %s after the signed inspect response', async (missing) => {
  const f = await fixture(); f.remove(missing)
  await expect(f.client.operateTaskTarget({ ...f.account, request: f.request })).rejects.toThrow()
  expect(f.actions).toEqual([])
})
it.skipIf(process.platform === 'win32')('rejects the wrong actual Account and an invalid Source signature before worker calls', async () => {
  const f = await fixture()
  await expect(f.client.collaborationAnalysis({ ...f.account, subject: randomUUID(), command: { action: 'task_target', request: f.request } })).rejects.toThrow()
  if (f.request.operation !== 'prepare') throw Error('wrong controlled call')
  await expect(f.client.operateTaskTarget({ ...f.account, request: { ...f.request, directive: { ...f.request.directive, signature: 'A'.repeat(86) } } })).rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.actions).toEqual([])
})
it.skipIf(process.platform === 'win32')('rejects a replaced original worker before Main can commit its signature', async () => {
  const f = await fixture(); f.replaceWorker()
  await expect(f.client.operateTaskTarget({ ...f.account, request: f.request })).rejects.toThrow()
  expect(f.actions).toEqual(['task_target'])
})
it.skipIf(process.platform === 'win32')('cannot use the closed original Unix connection', async () => {
  const f = await fixture(); f.client.close()
  await expect(f.client.operateTaskTarget({ ...f.account, request: f.request })).rejects.toThrow()
  expect(f.actions).toEqual([])
})
