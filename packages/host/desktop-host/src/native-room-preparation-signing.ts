/** Sign original native artifacts only after one guarded worker phase has completed. */
import { HOST_NATIVE_ROOM_PREPARATION_MAX_FRAME_BYTES, matchHostNativeRoomPreparationWorkerRead,
  parseHostNativeRoomPreparationProof, encodeHostNativeRoomPreparationProofPayload,
  parseHostNativeRoomAssertion, encodeHostNativeRoomAssertionPayload,
  parseHostSourceAuthorityAssertion, encodeHostSourceAuthorityPayload,
  parseHostGroupInputFenceAssertion, encodeHostGroupInputFencePayload,
  type HostNativeRoomAssertion, type HostNativeRoomPreparationTarget, type HostNativeRoomPreparationWorkerRead,
  type HostNativeRoomPreparationOutput, type HostNativeRoomPreparationOutcome,
  type HostNativeRoomPreparationProof, type HostControlRequestId } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

/** Build the entire fixed-size-signature frame before signing, then seal both original and new domains.
 * @param read Parsed actual worker observations matched to the original target.
 * @param target Original caller stage and selectors.
 * @param profileId Host-authorized actual Profile.
 * @param fields Current Account and installation fields captured after worker I/O.
 * @param requestId Original wire request, included in the complete frame budget.
 * @param signPayload Installation signing capability; it never enters the worker.
 * @returns Signed phase or an explicit inability, without truncation.
 */
export function signNativeRoomPreparation(read: HostNativeRoomPreparationWorkerRead,
  target: HostNativeRoomPreparationTarget, profileId: string,
  fields: Omit<HostNativeRoomAssertion, 'schema_version' | 'binding' | 'signature'>,
  requestId: HostControlRequestId, signPayload: (payload: Uint8Array) => string): HostNativeRoomPreparationOutcome {
  matchHostNativeRoomPreparationWorkerRead(read, target)
  if (read.state === 'upgrade_required') throw new HostAuthorityError('upgrade_required')
  if (read.state !== 'observed') return read
  const signature = 'A'.repeat(86), identity = { installation_id: fields.installation_id,
    installation_public_key: fields.installation_public_key, host_instance_id: fields.host_instance_id,
    process_nonce: fields.process_nonce }
  let output: HostNativeRoomPreparationOutput
  if (read.operation === 'prepare_source') {
    const { snapshot_digest: _digest, ...coordinates } = read.observation.source
    output = { operation: read.operation, source_snapshot: read.source_snapshot,
      native_room_assertion: parseHostNativeRoomAssertion({ schema_version: 1,
        binding: { room_id: read.observation.room_id, source: coordinates }, ...fields, signature }) }
  } else if (read.operation === 'attest_source') {
    const original = target as Extract<HostNativeRoomPreparationTarget, { operation: 'attest_source' }>
    output = { operation: read.operation, source_assertion: parseHostSourceAuthorityAssertion({
      schema_version: 1, challenge: original.source_challenge, ...identity, signature }) }
  } else {
    const original = target as Extract<HostNativeRoomPreparationTarget, { operation: 'attest_activation' }>
    output = { operation: read.operation, activation_assertion: parseHostGroupInputFenceAssertion({
      schema_version: 1, challenge: original.activation_challenge, ...identity, signature }) }
  }
  const value = { schema_version: 1, purpose: 'native_room_preparation',
    target, observation: read.observation, output, host_profile_id: profileId, ...fields, signature }
  if (Buffer.byteLength(JSON.stringify({ version: 1, type: 'result', request_id: requestId,
    method: 'profile.native_room_preparation', result: { outcome: { state: 'prepared', proof: value } } }), 'utf8') >
    HOST_NATIVE_ROOM_PREPARATION_MAX_FRAME_BYTES) return { state: 'too_large' }
  const draft = parseHostNativeRoomPreparationProof(value)
  if (output.operation === 'prepare_source') output = { ...output, native_room_assertion: {
    ...output.native_room_assertion, signature: signPayload(encodeHostNativeRoomAssertionPayload(output.native_room_assertion)) } }
  else if (output.operation === 'attest_source') output = { ...output, source_assertion: parseHostSourceAuthorityAssertion({
    ...output.source_assertion, signature: signPayload(encodeHostSourceAuthorityPayload(output.source_assertion)) }) }
  else output = { ...output, activation_assertion: parseHostGroupInputFenceAssertion({
    ...output.activation_assertion, signature: signPayload(encodeHostGroupInputFencePayload(output.activation_assertion)) }) }
  const unsigned = parseHostNativeRoomPreparationProof({ ...draft, output })
  return { state: 'prepared', proof: parseHostNativeRoomPreparationProof({ ...unsigned,
    signature: signPayload(encodeHostNativeRoomPreparationProofPayload(unsigned)) }) }
}

/** Verify the new domain and its separately signed original artifact.
 * @param proof Strictly parsed complete phase proof.
 * @param verifyPayload Verifier pinned to the current installation public key.
 * @returns Whether both signatures authenticate their exact original bytes.
 */
export function verifyNativeRoomPreparationSignatures(proof: HostNativeRoomPreparationProof,
  verifyPayload: (payload: Uint8Array, signature: string) => boolean): boolean {
  if (!verifyPayload(encodeHostNativeRoomPreparationProofPayload(proof), proof.signature)) return false
  const output = proof.output
  if (output.operation === 'prepare_source') return verifyPayload(
    encodeHostNativeRoomAssertionPayload(output.native_room_assertion), output.native_room_assertion.signature)
  if (output.operation === 'attest_source') return verifyPayload(
    encodeHostSourceAuthorityPayload(output.source_assertion), output.source_assertion.signature)
  return verifyPayload(encodeHostGroupInputFencePayload(output.activation_assertion), output.activation_assertion.signature)
}
