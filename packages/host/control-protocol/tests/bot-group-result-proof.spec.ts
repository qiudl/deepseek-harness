import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostBotGroupResultProofPayload,
  parseHostBotGroupResultProof } from '../src/bot-group-result-proof.ts'

const deliveryId = randomUUID()
const result = { id: `${deliveryId}:final`, deliveryId, groupId: randomUUID(),
  botId: 'my_bot', memberCycle: 2, seq: 7, status: 'completed' as const, text: 'done' }
const proof = { schema_version: 1 as const, authority_environment_id: randomUUID(),
  account_binding_handle: 'binding:test', authority_binding_version: 3,
  account_issuer: 'https://accounts.example.test', account_subject: 'subject',
  owner_user_id: 'alice', computer_id: 'desktop-1',
  slark_audience: 'https://slark.example.test', installation_id: randomUUID(),
  installation_public_key: 'A'.repeat(43), host_instance_id: randomUUID(),
  process_nonce: 'process', result, issued_at: 1_900_000_000_000,
  signature: 'A'.repeat(86) }

it('accepts an exact Bot result proof and signs the complete ordered identity', () => {
  expect(parseHostBotGroupResultProof(proof)).toEqual(proof)
  expect(JSON.parse(Buffer.from(encodeHostBotGroupResultProofPayload(proof)).toString()))
    .toEqual(['slark-bot-group-result-v1', 1, proof.authority_environment_id,
      proof.account_binding_handle, 3, proof.account_issuer, proof.account_subject,
      proof.owner_user_id, proof.computer_id, proof.slark_audience,
      proof.installation_id, proof.installation_public_key, proof.host_instance_id,
      proof.process_nonce, result.id, deliveryId, result.groupId, result.botId,
      result.memberCycle, result.seq, result.status, result.text, proof.issued_at])
})

it('rejects malformed proof envelopes and every altered identity or signature field', () => {
  for (const value of [null, [], '', 1, { ...proof, extra: true },
    Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'signature'))]) {
    expect(() => parseHostBotGroupResultProof(value)).toThrow('invalid_bot_group_result_proof')
  }
  const invalid: Record<string, unknown[]> = {
    schema_version: [2], authority_environment_id: [null, 'bad'],
    account_binding_handle: [null, ''], authority_binding_version: [1.5, 0],
    account_issuer: [null, ''], account_subject: [null, ''],
    owner_user_id: [null, ''], computer_id: [null, ''],
    slark_audience: [null, ''], installation_id: [null, 'bad'],
    installation_public_key: [null, 'bad'], host_instance_id: [null, 'bad'],
    process_nonce: [null, ''], issued_at: [1.5, 0], signature: [null, 'bad'],
  }
  for (const [field, variants] of Object.entries(invalid)) {
    for (const value of variants) {
      expect(() => parseHostBotGroupResultProof({ ...proof, [field]: value }),
        `${field}=${String(value)}`).toThrow('invalid_bot_group_result_proof')
    }
  }
  expect(() => parseHostBotGroupResultProof({ ...proof,
    result: { ...result, deliveryId: randomUUID() } })).toThrow('invalid_bot_group')
})
