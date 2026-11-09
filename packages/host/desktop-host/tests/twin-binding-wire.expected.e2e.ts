import { twinBindingFixture } from '../../control-protocol/tests/twin-binding-fixture.ts'
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { encodeHostTwinBindingDirective, encodeHostTwinBindingAck,
  parseHostTwinBindingInput } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTwinBindingDirective } from '@deepseek-ai/dsh-host-control-protocol'

it.skipIf(process.platform === 'win32')('recovers the original signed twin consent through built socket clients after Host restart', async () => {
  const built = await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(),
    'packages/host/desktop-host/lib/index.js')).href) as typeof import('../src/index.ts')
  const sdk = await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(),
    'packages/host/desktop-host/lib/host-control-client.js')).href) as typeof import('../src/client.ts')
  const v = twinBindingFixture()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'd-t-'))), uid = process.getuid!()
  let server: InstanceType<typeof built.UnixHostServer> | undefined
  let client: Awaited<ReturnType<typeof sdk.UnixHostClient.connect>> | undefined
  const resources: { ownership?: Awaited<ReturnType<typeof built.acquireSingleHostLock>> } = {}
  onTestFinished(async () => {
    client?.close()
    try { await server?.close() } finally {
      try { await resources.ownership?.release() } finally { rmSync(root, { recursive: true, force: true }) }
    }
  })
  const clock = { now: () => 1500 }, keys = generateKeyPairSync('ed25519'), cloud = generateKeyPairSync('ed25519')
  let identity = { hostInstanceId: randomUUID(), installationId: randomUUID(),
    installationPublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    installationPrivateKey: keys.privateKey, processNonce: Buffer.alloc(32, 3).toString('base64url'),
    executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
  const ring = { version: 1 as const, environmentId: v.authorityEnvironmentId, issuer: v.directive.issuer,
    keys: [{ kid: v.directive.keyId, publicKeyPem: cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: 0, validUntil: 100000 }] }
  const account = { authorityEnvironmentId: v.authorityEnvironmentId, accountBindingHandle: v.directive.accountBindingId,
    authorityBindingVersion: 1, issuer: v.directive.accountIssuer, subject: v.directive.accountSubject,
    keyHandle: 'keychain:twin-fixture', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), accountAccessToken: 'fixture-token' }
  const profileRoot = join(root, 'profiles'), workerProfiles: string[] = []
  let workerStarts = 0
  const start = async () => {
    const registry = new built.ProfileRegistry({ root: profileRoot, deviceIndexKey: Buffer.alloc(32, 7), clock })
    const host = new built.DesktopHost({ registry, clock, runtimeGeneration: 5,
      ensureProfileWorker: async () => { workerStarts++ },
      verifyAccountAccessToken: (token) => {
        if (token !== account.accountAccessToken) throw Error('invalid fixture token')
        return { issuer: account.issuer, subject: account.subject }
      } })
    resources.ownership = await built.acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: identity.processNonce })
    const socketPath = join(root, 'host.sock')
    server = new built.UnixHostServer({ socketPath, ownership: resources.ownership, expectedUid: uid,
      allowedDesktopExecutableDigests: new Set(['2'.repeat(64)]),
      attestPeer: async () => ({ uid, executableSignatureDigest: '2'.repeat(64) }),
      identity, host, now: clock.now, profilePersistenceGeneration: () => 1,
      trustedBotGroupKeyrings: [ring],
      resolveBotIdentity: async (profileId, botId, signal) => {
        signal.throwIfAborted(); workerProfiles.push(profileId)
        return botId === v.ack.botId ? { bot_id: botId, actor_ref: 'deepseek-bot:' + botId, display_name: 'Project operator' } : null
      },
      createTwinBindingReceiptStore: profileId => new built.TwinBindingReceipts({ profileId,
        installationId: identity.installationId, publicKey: identity.installationPublicKey,
        file: built.createPosixTwinBindingReceiptFile(join(root, 'receipts', profileId), uid) }),
    })
    await server.start()
    client = await sdk.UnixHostClient.connect({ socketPath, expectedUid: uid,
      trustedInstallationId: identity.installationId, trustedInstallationPublicKey: identity.installationPublicKey,
      trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      attestPeer: async () => ({ uid, executableSignatureDigest: identity.executableSignatureDigest }), now: clock.now })
    return client.ensureAccountProfile(account)
  }
  const ready = await start()
  const tree = (directory: string): unknown[] => readdirSync(directory).sort().map((name) => {
    const path = join(directory, name), stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw Error('unexpected fixture link')
    return [name, stat.mode, stat.isDirectory() ? tree(path) : createHash('sha256').update(readFileSync(path)).digest('hex')]
  })
  const before = JSON.stringify(tree(profileRoot)), startsBefore = workerStarts
  const h = (domain: string, value: unknown) => createHash('sha256').update(domain + '\0' + JSON.stringify(value)).digest('hex')
  const offer = structuredClone(v.offer), scopeArray = structuredClone(v.expected.dsh_to_slark.scopeArray)
  offer.directions[0].scope.sourceRef.hostProfileId = ready.profileId; scopeArray[6][2] = ready.profileId
  offer.directions[0].scope.scopeDigest = h('slark.project-operation-memory-confirmed-scope/v1', scopeArray)
  const offerArray = structuredClone(v.expected.offerArray)
  offerArray[4][0][1] = [...scopeArray, offer.directions[0].scope.scopeDigest]
  const directive = (): HostTwinBindingDirective => {
    const d = { ...v.directive, peer: { installationId: identity.installationId, publicKey: identity.installationPublicKey,
      hostInstanceId: identity.hostInstanceId, processNonce: identity.processNonce },
    scopeDigest: h('slark.twin-binding-offer/v1', offerArray),
    payloadDigest: h('slark.twin-binding-confirm-command/v1', [v.requestId, offerArray]) }
    return { ...d, signature: sign(null, Buffer.from(encodeHostTwinBindingDirective(d)), cloud.privateKey).toString('base64url') }
  }
  const confirm = () => parseHostTwinBindingInput({ directive: directive(),
    command: { operation: 'confirm', requestId: v.requestId, offer } })
  const receipt = () => {
    const d = { ...directive(), purpose: 'twin_binding_receipt' as const }
    d.signature = sign(null, Buffer.from(encodeHostTwinBindingDirective(d)), cloud.privateKey).toString('base64url')
    return parseHostTwinBindingInput({ directive: d, command: { operation: 'receipt', requestId: v.requestId,
      bindingId: d.bindingId, bindingGeneration: d.bindingGeneration, scopeDigest: d.scopeDigest, payloadDigest: d.payloadDigest } })
  }
  expect(await client!.operateTwinBinding({ ...account, input: receipt() })).toEqual({ state: 'missing' })
  const first = await client!.operateTwinBinding({ ...account, input: confirm() })
  if (first.state !== 'acknowledged') throw Error('no durable acknowledgement')
  const repeated = await client!.operateTwinBinding({ ...account, input: confirm() })
  const observed = { capability: client!.inspection.capabilities.includes('profile.twin_binding' as never),
    actualProfile: first.ack.hostProfileId === ready.profileId,
    validInstallationSignature: verify(null, Buffer.from(encodeHostTwinBindingAck(first.ack)),
      keys.publicKey, Buffer.from(first.ack.signature, 'base64url')),
    originalOnRetry: JSON.stringify(first) === JSON.stringify(repeated),
    noNewWorker: workerStarts === startsBefore, profileFilesUnchanged: before === JSON.stringify(tree(profileRoot)),
    originalAfterRestart: false, oldPeerRetained: false, allWorkerReadsAuthorized: false }
  client!.close(); await server!.close(); await resources.ownership!.release()
  identity = { ...identity, hostInstanceId: randomUUID(), processNonce: Buffer.alloc(32, 4).toString('base64url') }
  const next = await start()
  const recovered = await client!.operateTwinBinding({ ...account, input: receipt() })
  observed.originalAfterRestart = JSON.stringify(first) === JSON.stringify(recovered)
  observed.oldPeerRetained = recovered.state === 'acknowledged'
    && recovered.ack.peer.hostInstanceId !== client!.inspection.host_instance_id
  observed.allWorkerReadsAuthorized = next.profileId === ready.profileId && workerProfiles.every(id => id === ready.profileId)
  expect(observed).toEqual(JSON.parse(readFileSync(new URL('./expected/twin-binding-wire.json', import.meta.url), 'utf8')))
})
