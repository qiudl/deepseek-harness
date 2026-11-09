/** Host-owned verification of configured Cloud memory signing purposes and their original validity windows. */
import { verify } from 'node:crypto'
import {
  encodeHostProjectMemoryDirective, encodeHostProjectMemorySourceProof, encodeHostProjectMemoryReceipt, hostProjectMemoryHostAckDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemoryEnvironment, HostProjectMemoryDirective, HostProjectMemorySourceProof, HostProjectMemoryReceipt,
  HostProjectMemoryHostAck, HostProjectOperationEvent,
} from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'
/** Verify the exact configured memory purpose and Cloud key before any source call.
 * @param environments - Signed embedding policies.
 * @param directive - Strict parsed candidate permission.
 * @param now - Actual admission/publication clock.
 * @returns Nothing; unrelated purposes, environments, intervals and signatures reject.
 */
export function verifyProjectOperationMemoryDirective(
  environments: readonly HostProjectMemoryEnvironment[],
  directive: HostProjectMemoryDirective,
  now: number,
): void {
  const d = directive,
    policy = environments.find(
      e => e.keyring.environmentId === d.authorityEnvironmentId && e.keyring.issuer === d.issuer,
    )
  if (!policy) throw new HostAuthorityError('unavailable')
  const key = policy.keyring.keys.find(k => k.kid === d.keyId)
  if (
    !key ||
    d.audience !== policy.audience ||
    d.environmentKey !== policy.environmentKey ||
    !Number.isSafeInteger(now) ||
    now < d.issuedAt ||
    now >= d.expiresAt ||
    d.issuedAt < key.validFrom ||
    d.expiresAt > key.validUntil ||
    !verify(
      null,
      Buffer.from(encodeHostProjectMemoryDirective(d)),
      key.publicKeyPem,
      Buffer.from(d.signature, 'base64url'),
    )
  )
    throw new HostAuthorityError('unauthorized')
}

function cloudKey(environments: readonly HostProjectMemoryEnvironment[], value: {
  issuer: string
  keyId: string
  authorityEnvironmentId: string
}) {
  const key = environments.find(e => e.keyring.environmentId === value.authorityEnvironmentId &&
    e.keyring.issuer === value.issuer)?.keyring.keys.find(k => k.kid === value.keyId)
  if (!key) throw new HostAuthorityError('unauthorized')
  return key
}
/** Verify a genuine Slark source proof at admission or at its recorded historical stage time.
 * @param environments - Explicit fixed Cloud public policies.
 * @param proof - Closed original source proof.
 * @param at - Current admission time, or the immutable original stage time when recovering.
 * @returns Nothing; unknown keys, incorrect signatures and invalid original windows reject.
 */
export function verifyRecipientSourceProof(environments: readonly HostProjectMemoryEnvironment[],
  proof: HostProjectMemorySourceProof, at: number): void {
  const key = cloudKey(environments, proof)
  if (proof.side !== 'slark' || !Number.isSafeInteger(at) || at < proof.issuedAt || at >= proof.expiresAt ||
      proof.issuedAt < key.validFrom || proof.expiresAt > key.validUntil ||
      !verify(null, Buffer.from(encodeHostProjectMemorySourceProof(proof)), key.publicKeyPem, Buffer.from(proof.signature, 'base64url')))
    throw new HostAuthorityError('unauthorized')
}
/** Verify the immutable receipt using its original commit time, never recovery-now freshness.
 * @param environments - Explicit fixed Cloud public policies, including trusted historical keys.
 * @param receipt - Closed original receipt.
 * @returns Nothing; unknown keys are never fetched or replaced.
 */
export function verifyRecipientCloudReceipt(environments: readonly HostProjectMemoryEnvironment[],
  receipt: HostProjectMemoryReceipt): void {
  const key = cloudKey(environments, receipt)
  if (receipt.committedAt < key.validFrom || receipt.committedAt >= key.validUntil ||
      !verify(null, Buffer.from(encodeHostProjectMemoryReceipt(receipt)), key.publicKeyPem, Buffer.from(receipt.signature, 'base64url')))
    throw new HostAuthorityError('unauthorized')
}

/** Build only a worst-case JSON allocation template; it is never stored, signed, verified or published as a receipt.
 * @param directive - Exact fixed receipt issuer/environment from the original request.
 * @param ack - Original durable installation Ack.
 * @param events - Original bounded event identities and revisions.
 * @returns An encoding bound with maximal valid reference escaping and numeric widths; no authority.
 */
export function projectMemoryReceiptReservation(
  directive: Pick<HostProjectMemoryDirective, 'issuer' | 'authorityEnvironmentId'>,
  ack: HostProjectMemoryHostAck,
  events: readonly Pick<HostProjectOperationEvent, 'sourceEventId' | 'sourceRevision'>[],
) {
  return {
    schemaVersion: 1,
    issuer: directive.issuer,
    // Printable ASCII references exclude path separators; quotes maximize JSON expansion.
    keyId: '"'.repeat(256),
    authorityEnvironmentId: directive.authorityEnvironmentId,
    deliveryId: ack.deliveryId,
    batchId: ack.batchId,
    bindingId: ack.bindingId,
    bindingGeneration: ack.bindingGeneration,
    scopeVersion: ack.scopeVersion,
    scopeDigest: ack.scopeDigest,
    recipientDigest: ack.recipientDigest,
    readDirectiveDigest: ack.readDirectiveDigest,
    sourceProofDigest: ack.sourceProofDigest,
    applyDirectiveDigest: ack.applyDirectiveDigest,
    hostApplyAckDigest: hostProjectMemoryHostAckDigest(ack),
    batchDigest: ack.batchDigest,
    checkpoint: ack.checkpoint,
    stage: 'reconciliation_only',
    dispositions: events.map(event => ({
      sourceEventId: event.sourceEventId, sourceRevision: event.sourceRevision,
      state: 'reference_only', rightId: null, rightGeneration: null, reason: '"'.repeat(256),
    })),
    committedAt: Number.MAX_SAFE_INTEGER,
    signature: 'A'.repeat(86),
  }
}
