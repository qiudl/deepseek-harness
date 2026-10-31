import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  encodeRecoveryDescriptorPayload, parseRecoveryDescriptor, parseRecoveryDescribeInput, parseRecoveryValidateInput,
} from '@deepseek-ai/dsh-host-control-protocol'
import { HostRecoveryMaterials } from '../src/recovery-materials.ts'

const nonce = () => randomBytes(32).toString('base64url')
function fixture(pem = false) {
  const keys = generateKeyPairSync('ed25519')
  const identity = { installationId: randomUUID(),
    installationPublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    installationPrivateKey: pem ? keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) : keys.privateKey,
    schemaGeneration: 1 }
  const selected = { profileId: randomUUID(), bindingGeneration: 0 }
  const input = parseRecoveryDescribeInput({ challenge: nonce(), issuer: 'https://accounts.example.com',
    subject: 'selected-subject', profile_key_handle: nonce(), unlock_proof: nonce() })
  const lifetime = new AbortController()
  const authority = new HostRecoveryMaterials(identity, () => ({ ...selected }), async () => 2)
  return { keys, identity, selected, input, lifetime, authority }
}
describe('installation recovery signing without filesystem or worker authority', () => {
  it.each([false, true])('binds historical facts and fresh challenges (PEM=%s)', async (pem) => {
    const f = fixture(pem)
    const signed = await f.authority.describe(f.input, f.lifetime.signal)
    const request = parseRecoveryValidateInput({ challenge: nonce(), ...signed, unlock_proof: f.input.unlock_proof })
    expect(await f.authority.validate(request, f.lifetime.signal)).toMatchObject({
      valid: true, challenge: request.challenge,
      descriptorDigest: createHash('sha256').update(encodeRecoveryDescriptorPayload(signed.descriptor)).digest('hex'),
    })
    for (const [change, code] of [
      [{ schemaGeneration: 0 }, 'schema_unsupported'],
      [{ profileId: randomUUID() }, 'identity_mismatch'],
      [{ materialCommitment: '0'.repeat(64) }, 'material_invalid'],
      [{ installationId: randomUUID() }, 'installation_mismatch'],
      [{ installationKeyFingerprint: '0'.repeat(64) }, 'installation_mismatch'],
    ] as const) {
      const descriptor = parseRecoveryDescriptor({ ...signed.descriptor, ...change })
      const signature = sign(null, Buffer.from(encodeRecoveryDescriptorPayload(descriptor)), f.keys.privateKey).toString('base64url')
      await expect(f.authority.validate(parseRecoveryValidateInput({
        challenge: nonce(), descriptor, signature, unlock_proof: f.input.unlock_proof,
      }), f.lifetime.signal)).rejects.toMatchObject({ code })
    }
    await expect(f.authority.validate(parseRecoveryValidateInput({
      ...request, descriptor: { ...signed.descriptor, subject: 'altered' },
    }), f.lifetime.signal)).rejects.toMatchObject({ code: 'material_invalid' })
  })
  it('rejects cancellation after the generation promise settles but before signing resumes', async () => {
    const f = fixture()
    const authority = new HostRecoveryMaterials(f.identity, () => f.selected, () => {
      queueMicrotask(() => { queueMicrotask(() => { f.lifetime.abort() }) })
      return Promise.resolve(2)
    })
    await expect(authority.describe(f.input, f.lifetime.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it.each(['profile', 'binding'] as const)('rechecks %s after the asynchronous observation returns', async (kind) => {
    const f = fixture()
    const authority = new HostRecoveryMaterials(f.identity, () => ({ ...f.selected }), () => {
      queueMicrotask(() => { queueMicrotask(() => {
        if (kind === 'profile') f.selected.profileId = randomUUID()
        else f.selected.bindingGeneration += 1
      }) })
      return Promise.resolve(2)
    })
    await expect(authority.describe(f.input, f.lifetime.signal)).rejects.toMatchObject({ code: 'stale' })
  })
  it('checks the connection again before returning a validation observation', async () => {
    const f = fixture()
    const signed = await f.authority.describe(f.input, f.lifetime.signal)
    const authority = new HostRecoveryMaterials(f.identity, () => f.selected, () => {
      queueMicrotask(() => { queueMicrotask(() => { f.lifetime.abort() }) })
      return Promise.resolve(2)
    })
    await expect(authority.validate(parseRecoveryValidateInput({
      challenge: nonce(), ...signed, unlock_proof: f.input.unlock_proof,
    }), f.lifetime.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
