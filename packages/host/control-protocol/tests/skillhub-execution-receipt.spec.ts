/** REQ-20261013-0021 / T24206. Host execution receipt signing contract. */
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { SKILLHUB_EXECUTION_RECEIPT_DOMAIN, encodeSkillHubExecutionReceiptPayload,
  parseSkillHubExecutionReceipt, decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('base64url')
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const unsigned = { schema: 'slark-dsh-profile-execution-receipt/v1' as const,
  receiptId: randomUUID(), effectId: randomUUID(), requestDigest: 'a'.repeat(64),
  subject: 'human-1', registryId: 'registry-1', hostId: 'host-1', profileId: randomUUID(),
  hostInstallationId: randomUUID(), hostKeyId: sha(Buffer.from(publicKey, 'base64url')),
  bindingGeneration: '2', equipmentRevision: '4', hostRevision: '5',
  computerAuthorizationVersion: '6', packageOperationId: randomUUID(),
  packageId: 'package-1', versionId: 'version-1', archiveSha256: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64), sandboxOperationId: randomUUID(),
  containerId: 'd'.repeat(64), backendId: 'e'.repeat(64), image: 'sha256:' + 'f'.repeat(64),
  entry: 'scripts/run.cjs', args: [] as const, exitCode: 0, stdoutSha256: sha('output'),
  stderrSha256: sha(''), interrupted: false, quiescent: true as const, network: 'none' as const,
  readonly: true as const, publicKey }

it('round-trips only the exact Host execution receipt and signature payload', () => {
  const signature = sign(null, Buffer.from(SKILLHUB_EXECUTION_RECEIPT_DOMAIN
    + encodeSkillHubExecutionReceiptPayload(unsigned)), keys.privateKey).toString('base64url')
  const receipt = { ...unsigned, signature }
  expect(parseSkillHubExecutionReceipt(receipt)).toEqual(receipt)
  expect(verify(null, Buffer.from(SKILLHUB_EXECUTION_RECEIPT_DOMAIN
    + encodeSkillHubExecutionReceiptPayload(unsigned)), keys.publicKey,
  Buffer.from(signature, 'base64url'))).toBe(true)
  for (const change of [{ extra: true }, { schema: 'other' }, { effectId: '' },
    { requestDigest: '0' }, { args: ['forged'] }, { image: 'node:24' }, { readonly: false },
    { signature: 'bad' }])
    expect(() => parseSkillHubExecutionReceipt({ ...receipt, ...change })).toThrow()
})

it('round-trips only the fixed-package execution signing request and result', () => {
  const packageReceipt = { version: 1 as const, installationId: unsigned.hostInstallationId,
    challengeId: randomUUID(), operationId: unsigned.packageOperationId,
    packageId: unsigned.packageId, profileId: unsigned.profileId, hostKeyId: unsigned.hostKeyId,
    bindingGeneration: unsigned.bindingGeneration, revision: '3', versionId: unsigned.versionId,
    archiveSha256: unsigned.archiveSha256, manifestSha256: unsigned.manifestSha256,
    readiness: 'prepared' as const, loadEvidenceId: null, signature: 'A'.repeat(86) }
  const execution = { effectId: unsigned.effectId, requestDigest: unsigned.requestDigest,
    subject: unsigned.subject, registryId: unsigned.registryId, hostId: unsigned.hostId,
    profileId: unsigned.profileId, bindingGeneration: unsigned.bindingGeneration,
    equipmentRevision: unsigned.equipmentRevision, hostRevision: unsigned.hostRevision,
    computerAuthorizationVersion: unsigned.computerAuthorizationVersion,
    sandboxOperationId: unsigned.sandboxOperationId, containerId: unsigned.containerId,
    backendId: unsigned.backendId, image: unsigned.image, entry: unsigned.entry, args: unsigned.args,
    exitCode: unsigned.exitCode, stdoutSha256: unsigned.stdoutSha256,
    stderrSha256: unsigned.stderrSha256, interrupted: unsigned.interrupted,
    quiescent: unsigned.quiescent, network: unsigned.network, readonly: unsigned.readonly }
  const request = { version: 1, type: 'request', request_id: randomUUID(),
    method: 'profile.skillhub_execution_receipt', params: {
      client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
      jti: randomUUID(), issued_at: 1000, expires_at: 2000,
      profile_selector: `${'A'.repeat(43)}.${'A'.repeat(86)}`,
      package_receipt: packageReceipt, execution,
    } }
  const signature = sign(null, Buffer.from(SKILLHUB_EXECUTION_RECEIPT_DOMAIN
    + encodeSkillHubExecutionReceiptPayload(unsigned)), keys.privateKey).toString('base64url')
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: request.method, result: { receipt: { ...unsigned, signature } } }
  const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)
  for (const frame of [request, result])
    expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
  expect(() => decode({ ...request, params: { ...request.params,
    execution: { ...execution, args: ['forged'] } } })).toThrow()
  expect(() => decode({ ...request, params: { ...request.params,
    execution: { ...execution, extra: true } } })).toThrow()
  expect(() => decode({ ...result, result: { receipt: { ...result.result.receipt,
    signature: 'bad' } } })).toThrow()
})
