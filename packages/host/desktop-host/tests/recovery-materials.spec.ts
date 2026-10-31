import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  decodeHostControlFrame, encodeHostControlFrame, encodeRecoveryDescriptorPayload, parseRecoveryDescriptor,
  parseRecoveryDescribeInput, parseRecoveryValidateInput,
} from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'

const issuer = 'https://accounts.example.com'
const subject = 'original-subject'
const handle = Buffer.alloc(32, 5).toString('base64url')
const proof = Buffer.alloc(32, 9).toString('base64url')
const challenge = () => randomBytes(32).toString('base64url')
async function fixture(pem = false, legacy = false, beforeRead?: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-materials-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  let registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => 1000 } })
  const profile = await registry.registerAccount({ issuer, subject, keyHandle: handle, unlockMaterial: proof })
  if (legacy) {
    const snapshot = JSON.parse(readFileSync(join(root, 'profiles.json'), 'utf8')) as {
      profiles: Array<{ unlockVerifier: string | null }>
    }
    const original = snapshot.profiles[0]
    if (!original) throw new Error('missing fixture Profile')
    original.unlockVerifier = null
    writeFileSync(join(root, 'profiles.json'), JSON.stringify(snapshot))
    registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => 1000 } })
  }
  const before = readFileSync(join(root, 'profiles.json'))
  const worker = vi.fn()
  const host = new DesktopHost({ registry, clock: { now: () => 1000 }, runtimeGeneration: 5, ensureProfileWorker: worker })
  const keys = generateKeyPairSync('ed25519')
  const identity = {
    hostInstanceId: randomUUID(), installationId: randomUUID(),
    installationPublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    installationPrivateKey: pem ? keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) : keys.privateKey, processNonce: challenge(),
    executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1,
  }
  let persistence = 11
  const generationReader = async () => { await beforeRead?.(); return persistence }
  const options: ConstructorParameters<typeof HostControlAuthority>[0] = { identity, host,
    recoveryMaterialsPersistenceGeneration: generationReader,
    profilePersistenceGeneration: () => persistence, now: () => 1000 }
  const authority = new HostControlAuthority(options)
  const lifetime = new AbortController()
  const session = authority.openSession(randomUUID(), lifetime.signal)
  const client = await UnixHostClient.connectAuthenticatedTransport({
    trustedInstallationId: identity.installationId, trustedInstallationPublicKey: identity.installationPublicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: () => 1000,
  }, {
    call: async frame => decodeHostControlFrame(encodeHostControlFrame(
      await session.handleRequest(decodeHostControlFrame(encodeHostControlFrame(frame))))),
    isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort() },
  })
  onTestFinished(() => { client.close(); lifetime.abort(); session.close() })
  const describe = () => client.describeRecoveryMaterials(parseRecoveryDescribeInput({
    challenge: challenge(), issuer, subject, profile_key_handle: handle, unlock_proof: proof,
  }))
  return { root, registry, profile, before, worker, host, keys, identity, client, describe, session, lifetime,
    setPersistence: (value: number) => { persistence = value },
    removeGenerationReader: () => { Reflect.deleteProperty(options, 'recoveryMaterialsPersistenceGeneration') } }
}

describe.skipIf(process.platform === 'win32')('read-only original Host recovery materials', () => {
  it('authenticates a fresh descriptor and validates without registry writes, workers or grants', async () => {
    const f = await fixture()
    const signed = await f.describe()
    expect(signed.descriptor).toMatchObject({ issuer, subject, profileId: f.profile.profileId,
      installationId: f.identity.installationId, persistenceGeneration: 11, bindingGeneration: 0 })
    expect(verify(null, Buffer.from(encodeRecoveryDescriptorPayload(signed.descriptor)),
      f.keys.publicKey, Buffer.from(signed.signature, 'base64url'))).toBe(true)
    const expectedCommitment = createHash('sha256').update('DSH-RECOVERY-MATERIAL-v1\0')
      .update(Buffer.from(handle, 'base64url')).update(Buffer.from(proof, 'base64url')).digest('hex')
    expect(signed.descriptor.materialCommitment).toBe(expectedCommitment)
    f.setPersistence(12)
    const next = challenge()
    const validated = await f.client.validateRecoveryMaterials(parseRecoveryValidateInput({
      challenge: next, ...signed, unlock_proof: proof,
    }))
    expect(validated).toMatchObject({ valid: true, challenge: next, currentProfileId: f.profile.profileId,
      currentPersistenceGeneration: 12, currentBindingGeneration: 0, materialCommitment: expectedCommitment,
      descriptorDigest: createHash('sha256').update(encodeRecoveryDescriptorPayload(signed.descriptor)).digest('hex') })
    expect(readFileSync(join(f.root, 'profiles.json'))).toEqual(f.before)
    expect(f.worker).not.toHaveBeenCalled()
    await expect(f.host.openOfflineAccountProfile({ profileId: f.profile.profileId, bindingGeneration: 0,
      ownerId: 'different-owner' })).rejects.toMatchObject({ code: 'profile_locked' })
  })
  it('rejects cached recovery capability when its read-only persistence provider is no longer available', async () => {
    const f = await fixture()
    await f.describe()
    f.removeGenerationReader()
    await expect(f.describe()).rejects.toMatchObject({ code: 'upgrade_required' })
    expect(readFileSync(join(f.root, 'profiles.json'))).toEqual(f.before)
    expect(f.worker).not.toHaveBeenCalled()
  })
  it('rejects wrong issuer, subject, handle and proof without provisioning', async () => {
    const f = await fixture()
    for (const [change, code] of [
      [{ issuer: 'https://accounts.staging.example.com' }, 'identity_mismatch'],
      [{ subject: 'different-subject' }, 'identity_mismatch'],
      [{ profile_key_handle: Buffer.alloc(32, 6).toString('base64url') }, 'profile_not_found'],
      [{ unlock_proof: Buffer.alloc(32, 3).toString('base64url') }, 'material_invalid'],
    ] as const) {
      await expect(f.client.describeRecoveryMaterials(parseRecoveryDescribeInput({
        challenge: challenge(), issuer, subject, profile_key_handle: handle, unlock_proof: proof, ...change,
      }))).rejects.toMatchObject({ code })
    }
    expect(readFileSync(join(f.root, 'profiles.json'))).toEqual(f.before)
    expect(f.worker).not.toHaveBeenCalled()
    expect(() => f.host.verifyRecoveryMaterials({ issuer, subject, keyHandle: handle, unlockMaterial: 'invalid' }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })
  it('rejects an identity generation change while the asynchronous existing-content read is pending', async () => {
    let enter = () => {}, release = () => {}
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const pending = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture(false, false, async () => { enter(); await pending })
    const outcome = f.describe().then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered
      await f.registry.registerAccount({ issuer, subject, keyHandle: handle, unlockMaterial: proof,
        authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:new', authorityBindingVersion: 1 })
    } finally { release() }
    expect(await outcome).toMatchObject({ error: { code: 'stale' } })
    expect(f.worker).not.toHaveBeenCalled()
  })
  it('does not publish a descriptor after the authenticated connection closes during inspection', async () => {
    let enter = () => {}, release = () => {}
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const pending = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture(false, false, async () => { enter(); await pending })
    const outcome = f.describe().then(value => ({ value }), (error: unknown) => ({ error }))
    try { await entered; f.client.close() } finally { release() }
    expect(await outcome).toHaveProperty('error')
    expect(readFileSync(join(f.root, 'profiles.json'))).toEqual(f.before)
  })
  it('supports a stored PEM installation key and rejects old schemas or inconsistent signed facts', async () => {
    const f = await fixture(true)
    const signed = await f.describe()
    for (const [change, code] of [
      [{ schemaGeneration: 0 }, 'schema_unsupported'],
      [{ profileId: randomUUID() }, 'identity_mismatch'],
      [{ materialCommitment: '0'.repeat(64) }, 'material_invalid'],
    ] as const) {
      const descriptor = parseRecoveryDescriptor({ ...signed.descriptor, ...change })
      const signature = sign(null, Buffer.from(encodeRecoveryDescriptorPayload(descriptor)), f.keys.privateKey).toString('base64url')
      await expect(f.client.validateRecoveryMaterials(parseRecoveryValidateInput({
        challenge: challenge(), descriptor, signature, unlock_proof: proof,
      }))).rejects.toMatchObject({ code })
    }
  })
  it('rejects legacy unverifiable and ambiguous registry records without upgrading them', async () => {
    const legacy = await fixture(false, true)
    await expect(legacy.describe()).rejects.toMatchObject({ code: 'legacy_verifier_unsupported' })
    expect(readFileSync(join(legacy.root, 'profiles.json'))).toEqual(legacy.before)
    const ambiguous = await fixture()
    await ambiguous.registry.registerAccount({ issuer, subject: 'second-subject', keyHandle: handle, unlockMaterial: proof })
    const before = readFileSync(join(ambiguous.root, 'profiles.json'))
    await expect(ambiguous.describe()).rejects.toMatchObject({ code: 'profile_ambiguous' })
    expect(readFileSync(join(ambiguous.root, 'profiles.json'))).toEqual(before)
  })
  it('rejects signature mutation, other installations and wrong material before granting access', async () => {
    const f = await fixture()
    const signed = await f.describe()
    for (const [change, code] of [
      [{ descriptor: { ...signed.descriptor, subject: 'forged' } }, 'material_invalid'],
      [{ descriptor: { ...signed.descriptor, installationId: randomUUID() } }, 'installation_mismatch'],
      [{ unlock_proof: Buffer.alloc(32, 3).toString('base64url') }, 'material_invalid'],
    ] as const) {
      await expect(f.client.validateRecoveryMaterials(parseRecoveryValidateInput({
        challenge: challenge(), ...signed, unlock_proof: proof, ...change,
      }))).rejects.toMatchObject({ code })
    }
  })
})
