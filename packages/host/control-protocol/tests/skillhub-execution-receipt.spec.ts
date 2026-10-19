/** REQ-20261013-0021 / T24206. Host execution receipt signing contract. */
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { SKILLHUB_EXECUTION_RECEIPT_DOMAIN, encodeSkillHubExecutionReceiptPayload,
  parseSkillHubExecutionReceipt } from '../src/index.ts'

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
