/** Original-Host historical material checks; no registry, worker, lease or binding writes. */
import { createHash, createPublicKey, createPrivateKey, sign, verify, type KeyObject } from 'node:crypto'
import {
  encodeRecoveryDescriptorPayload,
  type RecoveryDescriptor, type RecoveryDescribeInput, type RecoveryValidateInput, type RecoveryValidation,
  type HostControlSignature, type HostControlSha256, type HostProfileId, type InstallationId,
} from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

interface MaterialsIdentity {
  readonly installationId: string
  readonly installationPublicKey: string
  readonly installationPrivateKey: KeyObject | string | Buffer
  readonly schemaGeneration: number
}
interface VerifiedMaterials {
  readonly profileId: string
  readonly bindingGeneration: number
}
function installationPublicKey(identity: MaterialsIdentity): KeyObject {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(identity.installationPublicKey, 'base64url')]), format: 'der', type: 'spki' })
}
function fingerprint(identity: MaterialsIdentity): HostControlSha256 {
  return createHash('sha256').update(installationPublicKey(identity).export({ format: 'der', type: 'spki' }))
    .digest('hex') as HostControlSha256
}
function commitment(handle: string, proof: string): HostControlSha256 {
  const handleBytes = Buffer.from(handle, 'base64url'), proofBytes = Buffer.from(proof, 'base64url')
  try {
    return createHash('sha256').update('DSH-RECOVERY-MATERIAL-v1\0').update(handleBytes).update(proofBytes)
      .digest('hex') as HostControlSha256
  } finally { handleBytes.fill(0); proofBytes.fill(0) }
}

/** Installation signing and fresh registry verification for Main-only access recovery. */
export class HostRecoveryMaterials {
  constructor(
    private readonly identity: MaterialsIdentity,
    private readonly verifyMaterials: (input: {
      readonly issuer: string
      readonly subject: string
      readonly keyHandle: string
      readonly unlockMaterial: string
    }) => VerifiedMaterials,
    private readonly persistenceGeneration: (profileId: string, signal: AbortSignal) => number | Promise<number>,
  ) {}

  /**
   * Sign existing identity and material ownership without starting workers or granting access.
   * @param input - Authenticated Main request with trusted selected identity and vault material.
   * @param signal - Connection lifetime; cancellation prevents a late signed result.
   * @returns Historical descriptor and installation signature; failures leave Host state unchanged.
   */
  async describe(input: RecoveryDescribeInput, signal: AbortSignal):
  Promise<{ readonly descriptor: RecoveryDescriptor; readonly signature: HostControlSignature }> {
    const { profile, persistenceGeneration } = await this.observe({ issuer: input.issuer, subject: input.subject,
      keyHandle: input.profile_key_handle, unlockMaterial: input.unlock_proof }, signal)
    this.recheck({ issuer: input.issuer, subject: input.subject, keyHandle: input.profile_key_handle,
      unlockMaterial: input.unlock_proof }, profile, signal)
    const descriptor: RecoveryDescriptor = Object.freeze({
      version: 1, type: 'dsh.host-access-recovery', installationId: this.identity.installationId as InstallationId,
      installationKeyFingerprint: fingerprint(this.identity), profileId: profile.profileId as HostProfileId,
      issuer: input.issuer, subject: input.subject, profileKeyHandle: input.profile_key_handle,
      materialCommitment: commitment(input.profile_key_handle, input.unlock_proof),
      bindingGeneration: profile.bindingGeneration, schemaGeneration: this.identity.schemaGeneration,
      persistenceGeneration, challenge: input.challenge,
    })
    const privateKey = this.identity.installationPrivateKey
    const signature = sign(null, Buffer.from(encodeRecoveryDescriptorPayload(descriptor)),
      typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey)
      .toString('base64url') as HostControlSignature
    return Object.freeze({ descriptor, signature })
  }

  /**
   * Validate historical ownership against this original installation and current registry.
   * @param input - Imported signed descriptor, exact material proof and fresh Main challenge.
   * @param signal - Connection lifetime checked around asynchronous persistence reads.
   * @returns Current generation observation; no Account, cloud, worker or file authority is granted.
   */
  async validate(input: RecoveryValidateInput, signal: AbortSignal): Promise<RecoveryValidation> {
    signal.throwIfAborted()
    const descriptor = input.descriptor
    if (descriptor.installationId !== this.identity.installationId
      || descriptor.installationKeyFingerprint !== fingerprint(this.identity)) throw new HostAuthorityError('installation_mismatch')
    const payload = Buffer.from(encodeRecoveryDescriptorPayload(descriptor))
    if (!verify(null, payload, installationPublicKey(this.identity), Buffer.from(input.signature, 'base64url'))) {
      throw new HostAuthorityError('material_invalid')
    }
    if (descriptor.schemaGeneration !== this.identity.schemaGeneration) throw new HostAuthorityError('schema_unsupported')
    const { profile: current, persistenceGeneration } = await this.observe({ issuer: descriptor.issuer, subject: descriptor.subject,
      keyHandle: descriptor.profileKeyHandle, unlockMaterial: input.unlock_proof }, signal)
    this.recheck({ issuer: descriptor.issuer, subject: descriptor.subject, keyHandle: descriptor.profileKeyHandle,
      unlockMaterial: input.unlock_proof }, current, signal)
    if (current.profileId !== descriptor.profileId) throw new HostAuthorityError('identity_mismatch')
    const materialCommitment = commitment(descriptor.profileKeyHandle, input.unlock_proof)
    if (materialCommitment !== descriptor.materialCommitment) throw new HostAuthorityError('material_invalid')
    return Object.freeze({
      valid: true, challenge: input.challenge, descriptorDigest: createHash('sha256').update(payload).digest('hex') as HostControlSha256,
      materialCommitment, currentInstallationId: this.identity.installationId as InstallationId,
      currentProfileId: current.profileId as HostProfileId, currentBindingGeneration: current.bindingGeneration,
      currentPersistenceGeneration: persistenceGeneration,
    })
  }
  private async observe(input: Parameters<HostRecoveryMaterials['verifyMaterials']>[0], signal: AbortSignal):
  Promise<{ readonly profile: VerifiedMaterials; readonly persistenceGeneration: number }> {
    signal.throwIfAborted()
    const before = this.verifyMaterials(input)
    const persistenceGeneration = await this.persistenceGeneration(before.profileId, signal)
    return { profile: before, persistenceGeneration }
  }

  private recheck(input: Parameters<HostRecoveryMaterials['verifyMaterials']>[0],
    before: VerifiedMaterials, signal: AbortSignal): void {
    signal.throwIfAborted()
    const current = this.verifyMaterials(input)
    if (current.profileId !== before.profileId || current.bindingGeneration !== before.bindingGeneration) {
      throw new HostAuthorityError('stale')
    }
  }

}
