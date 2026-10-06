import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import { parseHostCollaborationConsumptionReceipt, encodeHostCollaborationConsumptionReceiptPayload } from '../src/collaboration-consumption.ts'
it('shares exact consumption signing bytes with Slark and binds every persisted coordinate', () => {
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/dsh-collaboration-consumption-v1.json',import.meta.url),'utf8'))
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
