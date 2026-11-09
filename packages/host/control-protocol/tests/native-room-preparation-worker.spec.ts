import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseHostNativeRoomPreparationProof, parseHostNativeRoomPreparationTarget } from '../src/native-room-preparation.ts'
import { parseHostNativeRoomBindingRead, parseHostNativeRoomPreparationWorkerRead,
  matchHostNativeRoomPreparationWorkerRead } from '../src/native-room-preparation-worker.ts'
import type { HostNativeRoomPreparationProof } from '../src/native-room-preparation.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-room-preparation-v1.json', import.meta.url), 'utf8')) as {
  cases: { result: { outcome: { proof: HostNativeRoomPreparationProof } } }[]
}
const proofs = fixture.cases.map(value => parseHostNativeRoomPreparationProof(value.result.outcome.proof))
function observed(p = proofs[0]!) {
  const common = { state: 'observed', operation: p.output.operation, observation: p.observation }
  return p.output.operation === 'prepare_source' ? { ...common, source_snapshot: p.output.source_snapshot }
    : p.output.operation === 'attest_activation' ? { ...common, activation_fence: {
      workspace_id: p.output.activation_assertion.challenge.workspace_id,
      session_id: p.output.activation_assertion.challenge.session_id,
      group_id: p.output.activation_assertion.challenge.group_id,
      group_version: p.output.activation_assertion.challenge.group_version } } : common
}
const p = proofs[0]!, facts = { bot_id: p.observation.bot_id, room_id: p.observation.room_id,
  workspace_id: p.observation.workspace_id, member_set_digest: p.observation.member_set_digest }
const { snapshot_digest: _digest, ...coordinates } = p.observation.source

it('keeps the original four-coordinate binding distinct from its journal-derived snapshot digest', () => {
  const input = { state: 'bound', ...facts, source: coordinates }
  expect(parseHostNativeRoomBindingRead(input)).toEqual(input)
  for (const state of ['not_prepared', 'recovery_required'])
    expect(parseHostNativeRoomBindingRead({ state, ...facts })).toEqual({ state, ...facts })
  for (const state of ['invalid', 'unavailable', 'bot_unavailable', 'room_unavailable', 'membership_changed', 'source_conflict'])
    expect(parseHostNativeRoomBindingRead({ state })).toEqual({ state })
  for (const invalid of [{ ...input, source: p.observation.source }, { ...input, extra: true },
    { ...input, source: { ...coordinates, workspace_id: 'f0000000-0000-4000-8000-00000000000f' } },
    { ...input, source: { ...coordinates, session_id: input.room_id } },
    { ...input, bot_id: '../bot' }, { ...input, room_id: '../room' },
    { ...input, workspace_id: 'invalid' }, { ...input, member_set_digest: 'invalid' },
    { ...input, state: 'not_prepared' }, { state: 'missing' }])
    expect(() => parseHostNativeRoomBindingRead(invalid)).toThrow()
})

it('carries only unsigned stage-specific facts and matches them before the parent signs', () => {
  for (const proof of proofs) {
    const input = observed(proof), parsed = parseHostNativeRoomPreparationWorkerRead(input)
    expect(parsed).toEqual(input)
    expect(matchHostNativeRoomPreparationWorkerRead(parsed, proof.target)).toBe(parsed)
    expect(() => parseHostNativeRoomPreparationWorkerRead({ ...input, signature: 'A'.repeat(86) })).toThrow()
    for (const change of [{ bot_id: 'another-bot' }, { room_id: 'another-room' }, { member_set_digest: 'f'.repeat(64) }]) {
      const target = parseHostNativeRoomPreparationTarget({ ...proof.target, ...change })
      expect(() => matchHostNativeRoomPreparationWorkerRead(parsed, target)).toThrow()
    }
    if (proof.target.operation === 'prepare_source') {
      const changedWorkspace = parseHostNativeRoomPreparationTarget({ ...proof.target,
        workspace_id: 'f0000000-0000-4000-8000-00000000000f', expected_source: null })
      expect(() => matchHostNativeRoomPreparationWorkerRead(parsed, changedWorkspace)).toThrow()
      const target = parseHostNativeRoomPreparationTarget({ ...proof.target,
        expected_source: { ...proof.observation.source, source_message_id: 'another-message' } })
      expect(() => matchHostNativeRoomPreparationWorkerRead(parsed, target)).toThrow()
    }
  }
})

it('keeps definite inability separate from an observation or proof', () => {
  for (const state of ['bot_unavailable', 'room_unavailable', 'membership_changed', 'not_prepared',
    'recovery_required', 'source_conflict', 'too_large', 'upgrade_required']) {
    const read = parseHostNativeRoomPreparationWorkerRead({ state })
    expect(read).toEqual({ state })
    expect(matchHostNativeRoomPreparationWorkerRead(read, p.target)).toBe(read)
    expect(() => parseHostNativeRoomPreparationWorkerRead({ state, observation: p.observation })).toThrow()
  }
  for (const value of [{ state: 'invalid' }, { state: 1 }, { state: 'observed', operation: 'other' }])
    expect(() => parseHostNativeRoomPreparationWorkerRead(value)).toThrow()
})

it('rejects changed Source and activation coordinates and a cross-stage result', () => {
  const prepare = observed(), source = p.observation.source
  if (!('source_snapshot' in prepare)) throw Error('missing prepare fixture')
  for (const input of [{ ...prepare, observation: { ...prepare.observation, workspace_id: 'f0000000-0000-4000-8000-00000000000f' } },
    { ...prepare, source_snapshot: { ...prepare.source_snapshot, descriptor: { ...source, snapshot_digest: 'f'.repeat(64) } } }])
    expect(() => parseHostNativeRoomPreparationWorkerRead(input)).toThrow()
  const proof = proofs.find(value => value.output.operation === 'attest_activation')!
  const activation = observed(proof)
  if (!('activation_fence' in activation)) throw Error('missing activation fixture')
  for (const change of [{ workspace_id: 'f0000000-0000-4000-8000-00000000000f' }, { session_id: 'another-session' }])
    expect(() => parseHostNativeRoomPreparationWorkerRead({ ...activation,
      activation_fence: { ...activation.activation_fence, ...change } })).toThrow()
  const parsed = parseHostNativeRoomPreparationWorkerRead(activation)
  if (proof.target.operation !== 'attest_activation') throw Error('wrong activation fixture')
  for (const change of [{ group_id: 'f0000000-0000-4000-8000-00000000000f' }, { group_version: 2 }]) {
    if (parsed.state !== 'observed' || parsed.operation !== 'attest_activation') throw Error('missing parsed activation')
    expect(() => matchHostNativeRoomPreparationWorkerRead({ ...parsed,
      activation_fence: { ...parsed.activation_fence, ...change } }, proof.target)).toThrow()
  }
  expect(() => matchHostNativeRoomPreparationWorkerRead(parsed, p.target)).toThrow()
})

it('bounds the complete unsigned result and rejects non-data properties without executing them', () => {
  const input = observed()
  if (!('source_snapshot' in input)) throw Error('missing prepare fixture')
  const bytes = Buffer.byteLength(JSON.stringify(input))
  const exact = { ...input, source_snapshot: { ...input.source_snapshot,
    snapshot_json: input.source_snapshot.snapshot_json + ' '.repeat(49_152 - bytes) } }
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(49_152)
  expect(parseHostNativeRoomPreparationWorkerRead(exact)).toEqual(exact)
  expect(() => parseHostNativeRoomPreparationWorkerRead({ ...exact, source_snapshot: {
    ...exact.source_snapshot, snapshot_json: exact.source_snapshot.snapshot_json + ' ' } })).toThrow()
  let reads = 0
  const getter = Object.defineProperty({}, 'state', { enumerable: true, get() { reads++; return 'bound' } })
  const hidden = Object.defineProperty({}, 'state', { enumerable: false, value: 'bound' })
  for (const value of [null, undefined, [], true, Object.create({ state: 'bound' }), {}, getter, hidden]) {
    expect(() => parseHostNativeRoomBindingRead(value)).toThrow()
    expect(() => parseHostNativeRoomPreparationWorkerRead(value)).toThrow()
  }
  expect(reads).toBe(0)
})
