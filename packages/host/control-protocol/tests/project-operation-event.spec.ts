import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  createHostProjectOperationEvent,
  parseHostProjectOperationEvent,
  encodeHostProjectOperationEventPayload,
} from '../src/project-operation-event.ts'

const keys = ['originSide', 'originActorRef', 'sourceEventId', 'sourceRevision', 'sourceSequence', 'projectId',
  'occurredAt', 'kind', 'payloadDigest', 'taskRef', 'stepRef', 'invocationRef', 'evidenceRef', 'sourcePolicy',
  'sourceLocator', 'materialDependencies', 'content']
const rightA = '11111111-1111-4111-8111-111111111111'
const rightB = '22222222-2222-4222-8222-222222222222'
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
function fact() {
  return {
    originSide: 'dsh', originActorRef: 'bot_operator', sourceEventId: 'op_evt_1', sourceRevision: '9007199254740993',
    sourceSequence: '9223372036854775807', projectId: 'project_ai', occurredAt: 1700000000123, kind: 'result',
    taskRef: 'task_1', stepRef: 'step_2', invocationRef: 'invoke_3', evidenceRef: 'evidence_4',
    sourcePolicy: 'owner_native_operation_fact_v1', sourceLocator: null,
    materialDependencies: [{ rightId: rightA, generation: '2', revision: '3' }, { rightId: rightB, generation: '10', revision: '11' }],
    content: { goalSummary: '完成 café 项目 🐟', operationSummary: '运行检查', outcome: 'unknown',
      resultSummary: '调用已结束；业务待核', failureCode: null, unfinishedRefs: ['next_1'], verification: 'unverified' },
  }
}
function live() {
  return {
    originSide: 'slark', originActorRef: 'agent_delegate', sourceEventId: 'live_evt_2', sourceRevision: '7',
    sourceSequence: '0', projectId: 'project_ai', occurredAt: 0, kind: 'suggestion',
    taskRef: null, stepRef: null, invocationRef: null, evidenceRef: 'evidence_live', sourcePolicy: 'live_reference_v1',
    sourceLocator: { providerId: 'dsh_session', sourceEventId: 'live_evt_2', sourceRevision: '7', sourceDigest: 'f'.repeat(64) },
    materialDependencies: [], content: null,
  }
}
// Hand-transcribed frozen v3 field order, independent of either codec implementation.
const factPreimage = 'slark.project-operation-memory.event/v1\0["dsh","bot_operator","op_evt_1","9007199254740993","9223372036854775807","project_ai",1700000000123,"result","task_1","step_2","invoke_3","evidence_4","owner_native_operation_fact_v1",null,[["11111111-1111-4111-8111-111111111111","2","3"],["22222222-2222-4222-8222-222222222222","10","11"]],["完成 café 项目 🐟","运行检查","unknown","调用已结束；业务待核",null,["next_1"],"unverified"]]'
const livePreimage = 'slark.project-operation-memory.event/v1\0["slark","agent_delegate","live_evt_2","7","0","project_ai",0,"suggestion",null,null,null,"evidence_live","live_reference_v1",["dsh_session","live_evt_2","7","ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],[],null]'
const factDigest = 'd221cddd521b4936ac3ba8c927e6d93bb9b7a1c671baa9a1b8e719b038671df5'
const liveDigest = '464fe3ffba91854dddccccbd09ea4327ce42fe7e06f6e781e5a85426713a824f'

it.each([[fact, factPreimage, factDigest], [live, livePreimage, liveDigest]] as const)('matches independently literal frozen Event preimage and SHA-256 (%#)', (make, preimage, digest) => {
  const event = createHostProjectOperationEvent(make())
  expect(encodeHostProjectOperationEventPayload(event)).toBe(preimage)
  expect(hash(preimage)).toBe(digest)
  expect(event.payloadDigest).toBe(digest)
  expect(parseHostProjectOperationEvent(event)).toEqual(event)
  expect(Object.keys(event)).toEqual(keys)
  expect(preimage.includes('\0')).toBe(true)
  expect(preimage.includes('\\0')).toBe(false)
})

it('detaches, deeply freezes and canonicalizes producer and parsed objects without normalizing Unicode', () => {
  const input = fact()
  const event = createHostProjectOperationEvent(input)
  input.content.goalSummary = 'mutated'
  input.materialDependencies[0]!.generation = '99'
  input.content.unfinishedRefs.push('later')
  expect(encodeHostProjectOperationEventPayload(event)).toBe(factPreimage)
  const reversed = Object.fromEntries(Object.entries(event).reverse())
  const parsed = parseHostProjectOperationEvent(reversed)
  expect(Object.keys(parsed)).toEqual(keys)
  for (const value of [event, parsed, event.content, event.materialDependencies,
    event.materialDependencies[0], event.content?.unfinishedRefs])
    expect(Object.isFrozen(value)).toBe(true)
  expect(parsed).not.toBe(event)
  expect(parsed.materialDependencies).not.toBe(event.materialDependencies)
  expect(Object.keys(event.content ?? {})).toEqual(['goalSummary', 'operationSummary', 'outcome', 'resultSummary', 'failureCode', 'unfinishedRefs', 'verification'])
  expect(Object.keys(event.materialDependencies[0] ?? {})).toEqual(['rightId', 'generation', 'revision'])
  const decomposed = fact()
  decomposed.content.goalSummary = 'cafe\u0301'
  const composed = fact()
  composed.content.goalSummary = 'café'
  expect(createHostProjectOperationEvent(decomposed).payloadDigest).not.toBe(createHostProjectOperationEvent(composed).payloadDigest)
  const reference = createHostProjectOperationEvent(live())
  expect(Object.isFrozen(reference.sourceLocator)).toBe(true)
  expect(Object.keys(reference.sourceLocator ?? {})).toEqual(['providerId', 'sourceEventId', 'sourceRevision', 'sourceDigest'])
})

it('binds every Event input field and nested dependency/content member to its digest', () => {
  const original = createHostProjectOperationEvent(fact())
  const patches = [
    { originSide: 'slark' }, { originActorRef: 'different_actor' }, { sourceEventId: 'different_event' },
    { sourceRevision: '9007199254740994' }, { sourceSequence: '9223372036854775806' }, { projectId: 'different_project' },
    { occurredAt: 1700000000124 }, { kind: 'operation' }, { taskRef: null }, { stepRef: null },
    { invocationRef: null }, { evidenceRef: null }, { sourcePolicy: 'live_reference_v1' },
    { sourceLocator: live().sourceLocator },
    { materialDependencies: [{ ...fact().materialDependencies[0]!, generation: '3' }, fact().materialDependencies[1]!] },
    { materialDependencies: [{ ...fact().materialDependencies[0]!, revision: '4' }, fact().materialDependencies[1]!] },
    { materialDependencies: [{ ...fact().materialDependencies[0]!, rightId: '11111111-1111-4111-8111-111111111112' }, fact().materialDependencies[1]!] },
    ...[{ goalSummary: 'changed goal' }, { operationSummary: 'changed operation' }, { outcome: 'claimed' },
      { resultSummary: 'changed result' }, { failureCode: 'failure_1' }, { unfinishedRefs: ['other_1'] },
      { verification: 'observed_receipt' }].map(content => ({ content: { ...fact().content, ...content } })),
  ]
  for (const patch of patches) {
    expect(() => parseHostProjectOperationEvent({ ...original, ...patch })).toThrow()
    expect(() => encodeHostProjectOperationEventPayload({ ...original, ...patch })).toThrow()
  }
  for (const payloadDigest of ['0'.repeat(64), original.payloadDigest.toUpperCase(), 'bad', null])
    expect(() => parseHostProjectOperationEvent({ ...original, payloadDigest })).toThrow()
  const reference = createHostProjectOperationEvent(live())
  for (const locator of [{ providerId: 'other_provider' }, { sourceDigest: 'e'.repeat(64) }])
    expect(() => parseHostProjectOperationEvent({ ...reference, sourceLocator: { ...live().sourceLocator, ...locator } })).toThrow()
  expect(() => createHostProjectOperationEvent({ ...fact(), payloadDigest: original.payloadDigest })).toThrow()
  const { payloadDigest: _omitted, ...withoutDigest } = original
  expect(() => parseHostProjectOperationEvent(withoutDigest)).toThrow()
})

it('enforces exact fact/live/tombstone unions while treating classification as data rather than an authority grant', () => {
  for (const kind of ['operation', 'result', 'experience', 'suggestion']) {
    expect(createHostProjectOperationEvent({ ...fact(), kind }).kind).toBe(kind)
    expect(() => createHostProjectOperationEvent({ ...fact(), kind, content: null })).toThrow()
  }
  expect(createHostProjectOperationEvent({ ...fact(), kind: 'tombstone', content: null }).content).toBeNull()
  expect(() => createHostProjectOperationEvent({ ...fact(), kind: 'tombstone' })).toThrow()
  expect(() => createHostProjectOperationEvent({ ...fact(), sourceLocator: live().sourceLocator })).toThrow()
  for (const kind of ['operation', 'result', 'experience', 'suggestion', 'tombstone']) {
    expect(createHostProjectOperationEvent({ ...live(), kind }).content).toBeNull()
    expect(() => createHostProjectOperationEvent({ ...live(), kind, content: fact().content })).toThrow()
  }
  for (const patch of [{ sourceLocator: null }, { sourceLocator: { ...live().sourceLocator, sourceEventId: 'other' } },
    { sourceLocator: { ...live().sourceLocator, sourceRevision: '8' } },
    { sourceLocator: { ...live().sourceLocator, sourceDigest: 'F'.repeat(64) } },
    { sourcePolicy: 'unrestricted' }, { kind: 'success' }])
    expect(() => createHostProjectOperationEvent({ ...live(), ...patch })).toThrow()
  const reference = createHostProjectOperationEvent(live())
  expect(reference.sourceLocator?.sourceDigest).toBe('f'.repeat(64))
  expect(reference.sourceLocator?.sourceDigest).not.toBe(reference.payloadDigest)
  for (const claim of [{ ownerVerified: true }, { retentionGranted: true }, { rightId: rightA }, { rawArguments: {} }, { env: {} }, { stdout: 'secret' }]) {
    expect(() => createHostProjectOperationEvent({ ...fact(), ...claim })).toThrow()
    expect(() => parseHostProjectOperationEvent({ ...createHostProjectOperationEvent(fact()), ...claim })).toThrow()
  }
})

it('requires all declared keys and rejects non-JSON, hidden keys and accessors without invoking getters', () => {
  for (const input of [null, false, [], new Date(), undefined, 1n, () => fact(), { ...fact(), [Symbol('extra')]: true }])
    expect(() => createHostProjectOperationEvent(input)).toThrow()
  for (const key of Object.keys(fact())) {
    const missing = Object.fromEntries(Object.entries(fact()).filter(([field]) => field !== key))
    expect(() => createHostProjectOperationEvent(missing)).toThrow()
  }
  let reads = 0
  for (const location of ['event', 'content', 'dependency', 'locator']) {
    const input = location === 'locator' ? live() : fact()
    const declaredKey = location === 'content' ? 'goalSummary' : location === 'dependency' ? 'generation'
      : location === 'locator' ? 'providerId' : 'originActorRef'
    for (const descriptor of [{ enumerable: true, get() { reads++; return 'secret' } }, { enumerable: false, value: 'secret' }]) {
      const changed = structuredClone(input)
      const node = location === 'content' ? changed.content : location === 'dependency' ? changed.materialDependencies[0]
        : location === 'locator' ? changed.sourceLocator : changed
      if (!node) throw Error('fixture requires an actual object')
      Object.defineProperty(node, declaredKey, descriptor)
      expect(() => createHostProjectOperationEvent(changed)).toThrow()
    }
  }
  for (const field of ['materialDependencies', 'unfinishedRefs']) {
    const accessor: unknown[] = []
    Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return field === 'materialDependencies' ? fact().materialDependencies[0] : 'ref_1' } })
    expect(() => createHostProjectOperationEvent(field === 'materialDependencies'
      ? { ...fact(), materialDependencies: accessor } : { ...fact(), content: { ...fact().content, unfinishedRefs: accessor } })).toThrow()
  }
  const getterPayload = { ...createHostProjectOperationEvent(fact()) }
  Object.defineProperty(getterPayload, 'payloadDigest', { enumerable: true, get() { reads++; return 'a'.repeat(64) } })
  expect(() => parseHostProjectOperationEvent(getterPayload)).toThrow()
  expect(reads).toBe(0)
  for (const nested of [{ content: { ...fact().content, raw: 'secret' } },
    { materialDependencies: [{ ...fact().materialDependencies[0], extra: true }] },
    { content: { ...fact().content, unfinishedRefs: [undefined] } },
    { content: { ...fact().content, failureCode: () => 'bad' } }])
    expect(() => createHostProjectOperationEvent({ ...fact(), ...nested })).toThrow()
  for (const property of ['materialDependencies', 'unfinishedRefs']) {
    const sparse: unknown[] = []
    sparse.length = 1
    expect(() => createHostProjectOperationEvent(property === 'materialDependencies'
      ? { ...fact(), materialDependencies: sparse } : { ...fact(), content: { ...fact().content, unfinishedRefs: sparse } })).toThrow()
  }
  const cyclic: Record<string, unknown> = fact()
  cyclic.content = cyclic
  expect(() => createHostProjectOperationEvent(cyclic)).toThrow()
})

it('keeps int64 revisions/sequences exact and refuses noncanonical, unsafe or out-of-range coordinates', () => {
  const event = createHostProjectOperationEvent(fact())
  expect(event.sourceRevision).toBe('9007199254740993')
  expect(event.sourceSequence).toBe('9223372036854775807')
  for (const value of ['0', '01', '+1', '-1', '1.0', '1e2', '9223372036854775808', 1, 1n])
    expect(() => createHostProjectOperationEvent({ ...fact(), sourceRevision: value })).toThrow()
  for (const value of ['00', '-1', '+0', '1.0', '9223372036854775808', 0, 0n])
    expect(() => createHostProjectOperationEvent({ ...fact(), sourceSequence: value })).toThrow()
  for (const occurredAt of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])
    expect(() => createHostProjectOperationEvent({ ...fact(), occurredAt })).toThrow()
  expect(createHostProjectOperationEvent({ ...fact(), occurredAt: Number.MAX_SAFE_INTEGER }).occurredAt).toBe(Number.MAX_SAFE_INTEGER)
  for (const field of ['originActorRef', 'sourceEventId', 'projectId', 'taskRef', 'stepRef', 'invocationRef', 'evidenceRef']) {
    for (const value of ['', '.', '..', '/private', 'a/b', 'a\\b', 'é', 'a\n', 'x'.repeat(257)])
      expect(() => createHostProjectOperationEvent({ ...fact(), [field]: value })).toThrow()
    expect(createHostProjectOperationEvent({ ...fact(), [field]: 'x'.repeat(256) })).toHaveProperty(field, 'x'.repeat(256))
  }
  for (const originSide of ['DSH', 'host', '', null]) expect(() => createHostProjectOperationEvent({ ...fact(), originSide })).toThrow()
})

it('validates dependency identity, complete versions, ascending tuples and the twenty-item limit', () => {
  const dependency = { rightId: rightA, generation: '1', revision: '1' }
  for (const value of [
    [{ ...dependency, rightId: 'right_opaque' }], [{ ...dependency, rightId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }],
    [{ ...dependency, generation: '0' }], [{ ...dependency, revision: '01' }],
    [dependency, dependency], [...fact().materialDependencies].reverse(),
    [{ ...dependency, generation: '2' }, dependency],
    [{ ...dependency, revision: '2' }, dependency],
    Array.from({ length: 21 }, (_, i) => ({ ...dependency, revision: String(i + 1) })),
  ]) expect(() => createHostProjectOperationEvent({ ...fact(), materialDependencies: value })).toThrow()
  const twenty = Array.from({ length: 20 }, (_, i) => ({ ...dependency, revision: String(i + 1) }))
  expect(createHostProjectOperationEvent({ ...fact(), materialDependencies: twenty }).materialDependencies).toHaveLength(20)
  const precise = [{ ...dependency, generation: '9007199254740992' }, { ...dependency, generation: '9007199254740993' }]
  expect(createHostProjectOperationEvent({ ...fact(), materialDependencies: precise }).materialDependencies[1]?.generation).toBe('9007199254740993')
})

it('enforces summary UTF-8 bytes, reference limits, scalar enums and valid Unicode', () => {
  for (const field of ['goalSummary', 'operationSummary', 'resultSummary']) {
    const exactly = '界'.repeat(666) + 'ab'
    expect(Buffer.byteLength(exactly)).toBe(2000)
    const accepted = createHostProjectOperationEvent({ ...fact(), content: { ...fact().content, [field]: exactly } })
    expect(accepted.content).toHaveProperty(field, exactly)
    for (const value of [exactly + 'c', '\ud800', '\udc00', null, 1])
      expect(() => createHostProjectOperationEvent({ ...fact(), content: { ...fact().content, [field]: value } })).toThrow()
  }
  for (const outcome of ['pending', 'succeeded', 'failed', 'unknown', 'claimed'])
    expect(createHostProjectOperationEvent({ ...fact(), content: { ...fact().content, outcome } }).content?.outcome).toBe(outcome)
  for (const verification of ['observed_receipt', 'unverified']) {
    const accepted = createHostProjectOperationEvent({ ...fact(), content: { ...fact().content, verification } })
    expect(accepted.content?.verification).toBe(verification)
  }
  for (const patch of [{ outcome: 'ok' }, { verification: true }, { failureCode: '' }, { unfinishedRefs: ['../secret'] },
    { unfinishedRefs: Array.from({ length: 21 }, (_, i) => `unfinished_${i}`) }])
    expect(() => createHostProjectOperationEvent({ ...fact(), content: { ...fact().content, ...patch } })).toThrow()
  const accepted = createHostProjectOperationEvent({ ...fact(), content: { ...fact().content,
    unfinishedRefs: Array.from({ length: 20 }, (_, i) => `unfinished_${i}`) } })
  expect(accepted.content?.unfinishedRefs).toHaveLength(20)
})

it('applies the 8192-byte limit to the complete Event including metadata and payload digest', () => {
  const input = fact()
  input.materialDependencies = []
  input.content.goalSummary = ''
  input.content.operationSummary = ''
  input.content.resultSummary = ''
  input.content.unfinishedRefs = Array.from({ length: 20 }, (_, i) => `ref_${i}_`.padEnd(256, 'x'))
  const padding = 8192 - Buffer.byteLength(JSON.stringify({ ...input, payloadDigest: '0'.repeat(64) }))
  expect(padding).toBeGreaterThan(2000)
  expect(padding).toBeLessThan(4000)
  input.content.goalSummary = 'g'.repeat(2000)
  input.content.operationSummary = 'o'.repeat(padding - 2000)
  const event = createHostProjectOperationEvent(input)
  expect(Buffer.byteLength(JSON.stringify(event))).toBe(8192)
  expect(parseHostProjectOperationEvent(event)).toEqual(event)
  input.content.operationSummary += 'x'
  expect(() => createHostProjectOperationEvent(input)).toThrow()
})
