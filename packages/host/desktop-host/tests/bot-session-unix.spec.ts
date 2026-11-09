/** REQ-20261031-0006: actual signed Unix transport, Account grant and supervised worker. */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseHostBotSessionTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import { rootWorkerOperations } from '../src/root-worker-operations.ts'
import { UnixHostClient, UnixHostServer } from '../src/unix-transport.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

// Windows exercises its named-pipe carrier in windows-startup.spec.ts.
it.skipIf(process.platform === 'win32')('observes the original association over a signed Unix socket and rejects a replaced original worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-uds-'))
  const uid = process.getuid!(), clock = { now: () => 1000 }
  const ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: 'A'.repeat(43) })
  onTestFinished(async () => {
    try { await ownership.release() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const registry = new ProfileRegistry({ root: join(root, 'registry'), deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
  const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:session', authorityBindingVersion: 1,
    issuer: 'https://accounts.example.test', subject: randomUUID(), keyHandle: 'keychain:session',
    unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), accountAccessToken: 'fixture-token' }
  const target = parseHostBotSessionTarget({ bot_id: 'bot_1', session_id: 'session_1' })
  let replace = false, profileId = ''
  const read = vi.fn(async (botId: string, sessionId: string) => {
    if (replace) await workers.dispose(profileId)
    return botId === target.bot_id && sessionId === target.session_id ? target : null
  })
  const workers = new ProfileWorkerSupervisor(async () => ({ resolveBotSessionIdentity: read,
    closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(() => workers.disposeAll())
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
    ensureProfileWorker: async profile => workers.ensure({ profileId: profile.profileId,
      profileRoot: join(root, 'worker'), credentialHandle: profile.keyHandle, pluginRoots: [] }),
    verifyAccountAccessToken: (token) => {
      if (token !== account.accountAccessToken) throw Error('invalid fixture token')
      return { issuer: account.issuer, subject: account.subject }
    } })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 5, schemaGeneration: 1 }
  const socketPath = join(root, 'host.sock')
  const attestPeer = async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest })
  const server = new UnixHostServer({ socketPath, ownership, expectedUid: uid, attestPeer,
    allowedDesktopExecutableDigests: new Set([identity.executableSignatureDigest]), identity, host,
    profilePersistenceGeneration: () => 1, now: clock.now, ...rootWorkerOperations(workers) })
  onTestFinished(() => server.close())
  await server.start()
  const client = await UnixHostClient.connect({ socketPath, expectedUid: uid, attestPeer,
    trustedInstallationId: identity.installationId, trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: clock.now })
  onTestFinished(() => { client.close() })
  const input = { ...account, botId: target.bot_id, sessionId: target.session_id }
  await expect(client.resolveBotSessionIdentity(input)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(read).not.toHaveBeenCalled()
  const ready = await client.ensureAccountProfile(account)
  profileId = ready.profileId
  expect(await client.resolveBotSessionIdentity(input)).toEqual({ ...target, host_profile_id: profileId })
  expect(await client.resolveBotSessionIdentity({ ...input, sessionId: 'missing' })).toBeNull()
  await expect(client.resolveBotSessionIdentity({ ...input, subject: randomUUID() })).rejects.toThrow()
  replace = true
  await expect(client.resolveBotSessionIdentity(input)).rejects.toMatchObject({ code: 'stale' })
})
