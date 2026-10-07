import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import { parseHostCollaborationContinuationReceipt, encodeHostCollaborationContinuationReceiptPayload } from '../src/collaboration-continuation.ts'
it('shares exact consumption signing bytes with Slark and binds every persisted coordinate', () => {
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/dsh-collaboration-continuation-v1.json',import.meta.url),'utf8')) as { receipt: unknown; payload_hex: string }
  const receipt=parseHostCollaborationContinuationReceipt(fixture.receipt)
  const bytes=Buffer.from(encodeHostCollaborationContinuationReceiptPayload(receipt))
  expect(bytes.toString('hex')).toBe(fixture.payload_hex)
  const key=createPublicKey({ key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(receipt.installation_public_key,'base64url')]),format:'der',type:'spki' })
  expect(verify(null,bytes,key,Buffer.from(receipt.signature,'base64url'))).toBe(true)
  for (const patch of [{ observation_id: '30000000-0000-4000-8000-000000000003' }, { session_prefix: { ...receipt.commit.session_prefix, log_digest: 'f'.repeat(64) } }]) {
    const changed = parseHostCollaborationContinuationReceipt({ ...receipt, commit: { ...receipt.commit, ...patch } })
    expect(verify(null, encodeHostCollaborationContinuationReceiptPayload(changed), key, Buffer.from(receipt.signature,'base64url'))).toBe(false)
  }
})

it('rejects extra fields, accessors, invalid ordering and a consumption receipt in the observation domain', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/dsh-collaboration-continuation-v1.json', import.meta.url), 'utf8')) as { receipt: unknown }
  const receipt = parseHostCollaborationContinuationReceipt(fixture.receipt)
  for (const value of [null, [], new Date(), { ...receipt, extra: true }, { ...receipt, [Symbol('extra')]: true }])
    expect(() => parseHostCollaborationContinuationReceipt(value)).toThrow()
  let reads = 0
  const accessor = { ...receipt }
  Object.defineProperty(accessor, 'commit', { enumerable: true, get() { reads++; return receipt.commit } })
  expect(() => parseHostCollaborationContinuationReceipt(accessor)).toThrow()
  expect(reads).toBe(0)
  for (const patch of [{ observation_id: 'bad' }, { assistant_event_seq: -1 }, { assistant_event_seq: 0.5 },
    { assistant_event_seq: receipt.commit.consumption.session_event_seq },
    { assistant_event_seq: receipt.commit.session_prefix.event_count },
    { observation_kind: 'turn_completed' }, { session_prefix: { event_count:0,log_digest:'a'.repeat(64) } }])
    expect(() => parseHostCollaborationContinuationReceipt({ ...receipt, commit: { ...receipt.commit, ...patch } })).toThrow()
  expect(() => parseHostCollaborationContinuationReceipt({ ...receipt, commit: receipt.commit.consumption })).toThrow()
})
