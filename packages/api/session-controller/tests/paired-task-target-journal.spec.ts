/** Durable one-use admission metadata, independent of execution or Source authorization. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { hostTaskTargetDescriptorDigest, hostTaskReadyAdmissionDirectiveDigest,
  parseHostTaskTargetDescriptor, parseHostTaskReadyAdmissionDirective,
  parseHostTaskTargetConsumeChallengeForProposal, parseHostTaskTargetConsumeReceipt,
  hostTaskTargetConsumeChallengeDigest, hostTaskTargetConsumeReceiptDigest } from '@deepseek-ai/dsh-host-control-protocol'
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { openPairedTaskTargetJournal } from '../src/paired-task-target-journal.ts'
const data: unknown = JSON.parse(await readFile(new URL('../../../host/control-protocol/tests/fixtures/task-target-v1.json', import.meta.url), 'utf8'))
function field(key: string): unknown {
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, key)) throw Error('missing literal fixture')
  return Reflect.get(data, key)
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paired-task-target-journal-')), ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root); ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' }), journal = await openPairedTaskTargetJournal(facility)
  onTestFinished(async () => { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); await rm(root,
    { recursive: true, force: true }) })
  const original = parseHostTaskTargetDescriptor(field('descriptor'))
  const draft = { ...original, target: { ...original.target, journalEpoch: journal.epoch } }
  const descriptor = parseHostTaskTargetDescriptor({ ...draft, descriptorDigest: hostTaskTargetDescriptorDigest(draft) })
  const ready = parseHostTaskReadyAdmissionDirective({ ...parseHostTaskReadyAdmissionDirective(field('ready')),
    target: descriptor.target, descriptorDigest: descriptor.descriptorDigest })
  const literalChallenge = parseHostTaskTargetConsumeChallengeForProposal(field('consumeChallenge'), field('ready'))
  const challenge = parseHostTaskTargetConsumeChallengeForProposal({ ...literalChallenge, target: descriptor.target,
    descriptorDigest: descriptor.descriptorDigest, readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(ready) }, ready)
  const receipt = parseHostTaskTargetConsumeReceipt({ ...parseHostTaskTargetConsumeReceipt(field('consumeReceipt')),
    target: descriptor.target, descriptorDigest: descriptor.descriptorDigest,
    readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(ready), challengeDigest: hostTaskTargetConsumeChallengeDigest(challenge) })
  return { root, facility, journal, descriptor, ready, challenge, receipt }
}
it('retains one original projection and cannot rewrite it across restart or mint another command for the same original step', async () => {
  const f = await fixture()
  const record = await f.journal.prepare(f.descriptor, new AbortController().signal)
  expect(await f.journal.prepare(f.descriptor, new AbortController().signal)).toEqual(record)
  const draft = { ...f.descriptor, target: { ...f.descriptor.target, commandId: randomUUID() } }
  const changed = { ...draft, descriptorDigest: hostTaskTargetDescriptorDigest(draft) }
  await expect(f.journal.prepare(changed, new AbortController().signal)).rejects.toThrow('conflict')
  const bytes = await readFile(join(f.root, 'paired_task_targets_v1.json'))
  await f.journal.close()
  const reopened = await openPairedTaskTargetJournal(f.facility)
  expect(reopened.epoch).toBe(f.journal.epoch)
  expect(reopened.projection(record.itemId)).toEqual(record)
  expect(await readFile(join(f.root, 'paired_task_targets_v1.json'))).toEqual(bytes)
})
it('persists consume intent before external consume and never retries an unfinished intent after restart', async () => {
  const f = await fixture(), projection = await f.journal.prepare(f.descriptor, new AbortController().signal)
  const intent = await f.journal.consumeIntent(projection.itemId, f.ready, f.challenge, new AbortController().signal)
  expect(intent.state).toBe('consume_intent')
  expect(await f.journal.consumeIntent(projection.itemId, f.ready, f.challenge, new AbortController().signal)).toEqual(intent)
  expect(f.journal.inventory(f.ready.scope).length).toBe(2)
  await f.journal.close()
  const reopened = await openPairedTaskTargetJournal(f.facility)
  expect(reopened.admission(intent.itemId)?.state).toBe('unknown')
  await expect(reopened.consumeIntent(projection.itemId, f.ready, f.challenge, new AbortController().signal)).rejects.toThrow('unknown')
  expect(reopened.inventory(f.ready.scope).map(row => row.kind)).toEqual(['projection', 'admission'])
})
it('rejects changed proposals and later transfers for an already consumed logical step instead of creating a new admission', async () => {
  const f = await fixture(), projection = await f.journal.prepare(f.descriptor, new AbortController().signal)
  await f.journal.consumeIntent(projection.itemId, f.ready, f.challenge, new AbortController().signal)
  const changed = { ...f.ready, newSourceGrant: { ...f.ready.newSourceGrant, admissionId: randomUUID() } }
  const challenge = { ...f.challenge, admissionId: changed.newSourceGrant.admissionId,
    consumeIntentId: randomUUID(), readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(changed) }
  await expect(f.journal.consumeIntent(projection.itemId, changed, challenge, new AbortController().signal)).rejects.toThrow('conflict')
  expect(f.journal.inventory(f.ready.scope).length).toBe(2)
})
it('retains the exact Source consumption before one durable start intent and never remints start on replay', async () => {
  const f = await fixture(), projection = await f.journal.prepare(f.descriptor, new AbortController().signal)
  const intent = await f.journal.consumeIntent(projection.itemId, f.ready, f.challenge, new AbortController().signal)
  await expect(f.journal.startIntent(intent.itemId, new AbortController().signal)).rejects.toThrow('not_consumed')
  const consumed = await f.journal.recordSourceConsumption(intent.itemId, f.receipt, new AbortController().signal)
  expect(consumed.sourceConsumeReceiptDigest).toBe(hostTaskTargetConsumeReceiptDigest(f.receipt))
  expect(consumed.state).toBe('source_consumed')
  expect(await f.journal.recordSourceConsumption(intent.itemId, f.receipt, new AbortController().signal)).toEqual(consumed)
  const first = await f.journal.startIntent(intent.itemId, new AbortController().signal)
  expect(first.first).toBe(true); expect(first.record.state).toBe('start_intent')
  expect((await f.journal.startIntent(intent.itemId, new AbortController().signal)).first).toBe(false)
  await f.journal.close()
  const recovered = await openPairedTaskTargetJournal(f.facility)
  expect(recovered.admission(intent.itemId)?.state).toBe('unknown')
  await expect(recovered.startIntent(intent.itemId, new AbortController().signal)).rejects.toThrow('unknown')
})

it('records one durable message claim only after Source consumption and durable start, and refuses changed claim coordinates', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const projection = await f.journal.prepare(f.descriptor, signal)
  const intent = await f.journal.consumeIntent(projection.itemId, f.ready, f.challenge, signal)
  const claim = { messageId: 'paired-step:' + intent.admissionId, turn: 1, step: 1 }
  await expect(f.journal.recordClaim(intent.itemId, claim, signal)).rejects.toThrow('not_started')
  await f.journal.recordSourceConsumption(intent.itemId, f.receipt, signal)
  await f.journal.startIntent(intent.itemId, signal)
  const claimed = await f.journal.recordClaim(intent.itemId, claim, signal)
  expect(claimed).toMatchObject({ state: 'claimed', ...claim })
  expect(await f.journal.recordClaim(intent.itemId, claim, signal)).toEqual(claimed)
  await expect(f.journal.recordClaim(intent.itemId, { ...claim, step: 2 }, signal)).rejects.toThrow('conflict')
  await f.journal.close()
  const reopened = await openPairedTaskTargetJournal(f.facility)
  expect(reopened.admission(intent.itemId)?.state).toBe('unknown')
  await expect(reopened.recordClaim(intent.itemId, claim, signal)).rejects.toThrow('unknown')
})

it('commits installation signatures once without permitting a different projection or consume challenge', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const draft = { ...f.descriptor, signature: 'A'.repeat(86) }
  const projection = await f.journal.prepare(draft, signal)
  const signed = await f.journal.commitProjection(projection.itemId, f.descriptor, signal)
  expect(JSON.parse(signed.descriptorJson)).toEqual(f.descriptor)
  expect(await f.journal.commitProjection(projection.itemId, f.descriptor, signal)).toEqual(signed)
  await expect(f.journal.commitProjection(projection.itemId, { ...f.descriptor, signature: 'B'.repeat(85) + 'A' }, signal))
    .rejects.toThrow('conflict')
  const challenge = { ...f.challenge, signature: 'A'.repeat(86) }
  const intent = await f.journal.consumeIntent(projection.itemId, f.ready, challenge, signal)
  const final = await f.journal.commitChallenge(intent.itemId, f.challenge, signal)
  expect(JSON.parse(final.challengeJson)).toEqual(f.challenge)
  expect(await f.journal.commitChallenge(intent.itemId, f.challenge, signal)).toEqual(final)
  await expect(f.journal.commitChallenge(intent.itemId, { ...f.challenge, consumeIntentId: randomUUID() }, signal))
    .rejects.toThrow('conflict')
})
