import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import { parseHostCollaborationConsumptionReceipt, encodeHostCollaborationConsumptionReceiptPayload } from '../src/collaboration-consumption.ts'
it('shares exact consumption signing bytes with Slark and binds every persisted coordinate', () => {
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/dsh-collaboration-consumption-v1.json',import.meta.url),'utf8')) as { receipt: unknown; payload_hex: string }
  const receipt=parseHostCollaborationConsumptionReceipt(fixture.receipt)
  const bytes=Buffer.from(encodeHostCollaborationConsumptionReceiptPayload(receipt))
  expect(bytes.toString('hex')).toBe(fixture.payload_hex)
  const key=createPublicKey({ key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(receipt.installation_public_key,'base64url')]),format:'der',type:'spki' })
  expect(verify(null,bytes,key,Buffer.from(receipt.signature,'base64url'))).toBe(true)
  for(const patch of [{ consumer_step_id:receipt.commit.consumption_id },{ consuming_step:{ ...receipt.commit.consuming_step,turn:2 } },{ consumer_started_at:'2026-10-06T00:00:01.000Z' }]) {
    const changed=parseHostCollaborationConsumptionReceipt({ ...receipt,commit:{ ...receipt.commit,...patch } })
    expect(verify(null,Buffer.from(encodeHostCollaborationConsumptionReceiptPayload(changed)),key,Buffer.from(receipt.signature,'base64url'))).toBe(false)
  }
})
it('rejects malformed wire evidence, hidden fields and accessors without invoking them', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/dsh-collaboration-consumption-v1.json', import.meta.url), 'utf8')) as { receipt: unknown }
  const receipt = parseHostCollaborationConsumptionReceipt(fixture.receipt)
  for (const value of [null, false, [], new Date(), { ...receipt, [Symbol('extra')]: true }, { ...receipt, extra: true }])
    expect(() => parseHostCollaborationConsumptionReceipt(value)).toThrow('invalid_consumption_receipt')
  let reads = 0
  for (const descriptor of [{ enumerable: true, get() { reads++; return receipt.commit } }, { enumerable: false, value: receipt.commit }]) {
    const dirty = { ...receipt }
    Object.defineProperty(dirty, 'commit', descriptor)
    expect(() => parseHostCollaborationConsumptionReceipt(dirty)).toThrow('invalid_consumption_receipt')
  }
  expect(reads).toBe(0)
  expect(parseHostCollaborationConsumptionReceipt(Object.assign(Object.create(null) as object, receipt))).toEqual(receipt)
  for (const patch of [
    { root_task_id: 1 }, { root_task_id: 'invalid' }, { session_event_seq: '1' },
    { session_event_seq: -1 }, { session_event_seq: 0.5 }, { task_revision: 2 },
    { consumer_started_at: '2026-99-06T00:00:00.000Z' }, { consumer_started_at: '2026-02-30T00:00:00.000Z' },
    { session_event_seq: receipt.commit.consuming_step.start_event_seq },
    { session_event_seq: receipt.commit.session_prefix.event_count },
  ]) expect(() => parseHostCollaborationConsumptionReceipt({ ...receipt, commit: { ...receipt.commit, ...patch } })).toThrow('invalid_consumption_receipt')
})
