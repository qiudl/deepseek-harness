import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createHostProjectOperationEvent, type HostProjectOperationEvent } from '../src/project-operation-event.ts'
import * as wire from '../src/project-operation-memory.ts'
import * as commands from '../src/project-operation-memory-command.ts'
import * as results from '../src/project-operation-read-result.ts'

type Mutable<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T
type CommandTuple = [
  Exclude<commands.HostProjectMemoryCommands['prepare_snapshot'], { mode: 'resume' }>,
  Extract<commands.HostProjectMemoryCommands['prepare_snapshot'], { mode: 'resume' }>,
  commands.HostProjectMemoryCommands['history_page'],
  commands.HostProjectMemoryCommands['delta_page'],
  commands.HostProjectMemoryCommands['search'],
  commands.HostProjectMemoryCommands['evidence'],
  commands.HostProjectMemoryStage,
  Extract<commands.HostProjectMemoryCommands['apply'], { phase: 'finalize' }>,
  commands.HostProjectMemoryCommands['receipt'],
]
type ResultTuple = [
  results.HostProjectMemoryReadResults['prepare_snapshot'],
  results.HostProjectMemoryReadResults['history_page'],
  results.HostProjectMemoryReadResults['delta_page'],
  results.HostProjectMemoryReadResults['search'],
  Extract<results.HostProjectMemoryReadResults['evidence'], { status: 'ready' }>,
  { status: 'missing' },
]
type WireTuple = [
  wire.HostProjectMemoryDirective,
  wire.HostProjectMemorySourceProof,
  wire.HostProjectMemoryProjectionProof,
  wire.HostProjectMemoryHostAck,
  wire.HostProjectMemoryReceipt,
]
type Vector<T> = { value: Mutable<T>; preimage: string; digest: string; fields: unknown[] }
type WireVectors<T extends readonly unknown[]> = { [I in keyof T]: Vector<T[I]> }
type CommandVectors<T extends readonly unknown[]> = {
  [I in keyof T]: { operation: wire.HostProjectMemoryOperation; body: Mutable<T[I]>; digest: string; fields: unknown[] }
}
type ResultVectors<T extends readonly unknown[]> = {
  [I in keyof T]: {
    operation: wire.HostProjectMemoryReadOperation
    value: Mutable<T[I]>
    digest: string
    fields: unknown[]
  }
}
type Fixture = {
  wire: WireVectors<WireTuple>
  commands: CommandVectors<CommandTuple>
  readResults: ResultVectors<ResultTuple>
  event: Mutable<
    Omit<Extract<HostProjectOperationEvent, { sourcePolicy: 'owner_native_operation_fact_v1' }>, 'content'> & {
      content: NonNullable<HostProjectOperationEvent['content']>
    }
  >
  batch: { context: { direction: string; scopeDigest: string; recipientDigest: string }; digest: string }
  finalizeResult: Mutable<results.HostProjectMemoryFinalizeResult>
  receiptResult: {
    status: string
    hostApplyAck: Mutable<wire.HostProjectMemoryHostAck>
    cloudMaterialReceipt: Mutable<wire.HostProjectMemoryReceipt>
    effectiveState: string
  }
}
// These independent literal fixtures are exercised by every public parser and encoder below.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/project-operation-memory-v3-owner-private.json', import.meta.url), 'utf8'),
) as Fixture

describe('frozen v3 owner-private memory bytes', () => {
  it('keeps all signed purposes and all seven command arrays literal', () => {
    const codecs = [
      [
        wire.parseHostProjectMemoryDirective,
        wire.encodeHostProjectMemoryDirective,
        wire.hostProjectMemoryDirectiveDigest,
      ],
      [
        wire.parseHostProjectMemorySourceProof,
        wire.encodeHostProjectMemorySourceProof,
        wire.hostProjectMemorySourceProofDigest,
      ],
      [wire.parseHostProjectMemoryProjectionProof, wire.encodeHostProjectMemoryProjectionProof, null],
      [wire.parseHostProjectMemoryHostAck, wire.encodeHostProjectMemoryHostAck, wire.hostProjectMemoryHostAckDigest],
      [wire.parseHostProjectMemoryReceipt, wire.encodeHostProjectMemoryReceipt, wire.hostProjectMemoryReceiptDigest],
    ] as const
    fixture.wire.forEach((vector: { value: unknown; preimage: string; digest: string }, i: number) => {
      const [parse, encode, hash] = codecs[i]!
      expect(parse(vector.value)).toEqual(vector.value)
      expect(encode(vector.value)).toBe(vector.preimage)
      if (hash) expect(hash(vector.value)).toBe(vector.digest)
    })
    for (const vector of fixture.commands) {
      expect(commands.parseHostProjectMemoryCommand(vector.operation, vector.body)).toEqual(vector.body)
      expect(commands.hostProjectMemoryCommandDigest(vector.operation, vector.body)).toBe(vector.digest)
    }
    expect(commands.hostProjectMemoryBatchDigest(fixture.batch.context, fixture.commands[6].body)).toBe(
      fixture.batch.digest,
    )
    expect(
      commands.parseHostProjectMemoryRequest({
        directive: fixture.wire[0].value,
        commandBody: fixture.commands[0].body,
      }),
    ).toEqual({ directive: fixture.wire[0].value, commandBody: fixture.commands[0].body })
  })
  it('pins every read result and Doc-defined finalize/receipt result', () => {
    for (const vector of fixture.readResults) {
      expect(results.parseHostProjectMemoryReadResult(vector.operation, vector.value)).toEqual(vector.value)
      expect(results.hostProjectMemoryReadResultDigest(vector.operation, vector.value)).toBe(vector.digest)
    }
    expect(results.parseHostProjectMemoryFinalizeResult(fixture.finalizeResult)).toEqual(fixture.finalizeResult)
    expect(results.parseHostProjectMemoryReceiptResult(fixture.receiptResult)).toEqual(fixture.receiptResult)
  })
})

const directive = () => structuredClone(fixture.wire[0].value)
const source = () => structuredClone(fixture.wire[1].value)
const projection = () => structuredClone(fixture.wire[2].value)
const ack = () => structuredClone(fixture.wire[3].value)
const receipt = () => structuredClone(fixture.wire[4].value)
function command<I extends number>(i: I): Mutable<CommandTuple[I]>
function command(i: number): unknown {
  return structuredClone(fixture.commands[i]?.body)
}
function result<I extends number>(i: I): Mutable<ResultTuple[I]>
function result(i: number): unknown {
  return structuredClone(fixture.readResults[i]?.value)
}
const badDigest = 'f'.repeat(64)
const id2 = 'abcdefab-0000-4000-8000-000000000001'
function request(operation: wire.HostProjectMemoryOperation, body: unknown, patch: Record<string, unknown> = {}) {
  return {
    directive: {
      ...directive(),
      operation,
      commandDigest: commands.hostProjectMemoryCommandDigest(operation, body),
      ...patch,
    },
    commandBody: body,
  }
}
function envelope(
  operation: wire.HostProjectMemoryReadOperation,
  value: unknown,
  kind: 'source' | 'projection' = 'source',
  body?: unknown,
) {
  const index = { prepare_snapshot: 0, history_page: 2, delta_page: 3, search: 4, evidence: 5 }[operation]
  const req = request(operation, body ?? command(index))
  const common = {
    operation,
    readDirectiveDigest: wire.hostProjectMemoryDirectiveDigest(req.directive),
    resultDigest: results.hostProjectMemoryReadResultDigest(operation, value),
  }
  const sourceProof = {
    ...source(),
    ...common,
    snapshotId:
      operation === 'delta_page' || operation === 'evidence'
        ? null
        : operation === 'search'
          ? 'search_1'
          : 'snapshot_1',
  }
  const projectionProof = { ...projection(), ...common }
  return {
    req,
    value: {
      status: 'ok',
      operation,
      result: value,
      sourceProof: kind === 'source' ? sourceProof : null,
      projectionProof: kind === 'projection' ? projectionProof : null,
    },
  }
}
function assertEnvelope(
  operation: wire.HostProjectMemoryReadOperation,
  value: unknown,
  kind: 'source' | 'projection' = 'source',
  body?: unknown,
) {
  const e = envelope(operation, value, kind, body)
  const opts =
    operation === 'history_page' || operation === 'delta_page'
      ? { previousCheckpoint: fixture.commands[1].body.checkpoint }
      : {}
  expect(results.parseHostProjectMemoryReadEnvelope(e.req, e.value, opts)).toEqual(e.value)
  return e
}

it('accepts both confirmed directions and explicit null peers without granting authority', () => {
  const offer = JSON.parse(readFileSync(new URL('./fixtures/twin-binding-offer-v1.json', import.meta.url), 'utf8')) as {
    offer: { directions: [{ scope: unknown }, { scope: wire.HostProjectMemoryDirective['scope'] }] }
  }
  expect(wire.parseHostProjectMemoryDirective({ ...directive(), peer: null }).peer).toBeNull()
  expect(wire.encodeHostProjectMemoryDirective({ ...directive(), peer: null })).toContain('null')
  expect(
    wire.parseHostProjectMemoryDirective({
      ...directive(),
      direction: 'slark_to_dsh',
      scope: offer.offer.directions[1].scope,
    }).direction,
  ).toBe('slark_to_dsh')
  for (const patch of [
    { direction: 'slark_to_dsh' },
    { expiresAt: 1000 },
    { expiresAt: 16001 },
    { accountBindingVersion: 0 },
    { accountIssuer: 'https://attacker.example' },
    { issuer: 'http://cloud.example' },
    { issuer: 'https://cloud.example/path' },
    { nonce: 'A'.repeat(42) },
    { nonce: 'A'.repeat(44) },
    { nonce: 'A'.repeat(42) + 'B' },
    { signature: 'A'.repeat(85) },
    { signature: 'A'.repeat(86) + '=' },
    { schemaVersion: 2 },
    { purpose: 'private_history' },
    { operation: 'all' },
  ])
    expect(() => wire.parseHostProjectMemoryDirective({ ...directive(), ...patch })).toThrow()
  for (const patch of [{ audienceKind: 'group' }, { audienceVersion: '2' }])
    expect(() =>
      wire.parseHostProjectMemoryDirective({
        ...directive(),
        scope: { ...directive().scope, recipientRef: { ...directive().scope.recipientRef, ...patch } },
      }),
    ).toThrow()
  for (const patch of [
    { historyFrom: null },
    { historyTo: null },
    { retentionConsentRef: { ...directive().scope.retentionConsentRef, presentationVersion: 'v2' } },
  ])
    expect(() =>
      wire.parseHostProjectMemoryDirective({ ...directive(), scope: { ...directive().scope, ...patch } }),
    ).toThrow()
})

it('rejects missing, extra, hidden, inherited, accessor and non-JSON fields without invoking getters', () => {
  const parsers = [
    wire.parseHostProjectMemoryDirective,
    wire.parseHostProjectMemorySourceProof,
    wire.parseHostProjectMemoryProjectionProof,
    wire.parseHostProjectMemoryHostAck,
    wire.parseHostProjectMemoryReceipt,
  ]
  let reads = 0
  for (const [i, parse] of parsers.entries()) {
    const value = structuredClone(fixture.wire[i]!.value)
    for (const key of Object.keys(value)) {
      const missing = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
      expect(() => parse(missing)).toThrow()
      for (const descriptor of [
        { enumerable: false, value: 'hidden' },
        {
          enumerable: true,
          get() {
            reads++
            return 'secret'
          },
        },
      ]) {
        const changed = { ...value }
        Object.defineProperty(changed, key, descriptor)
        expect(() => parse(changed)).toThrow()
      }
    }
    for (const changed of [
      null,
      [],
      new Date(),
      Object.create(value),
      { ...value, extra: true },
      { ...value, [Symbol('extra')]: 1 },
    ])
      expect(() => parse(changed)).toThrow()
    const parsed = parse(value)
    value.signature = 'changed'
    expect(parsed.signature).not.toBe(value.signature)
    expect(Object.isFrozen(parsed)).toBe(true)
  }
  for (const vector of fixture.commands) {
    for (const key of Object.keys(vector.body)) {
      const body = Object.fromEntries(Object.entries(vector.body).filter(([name]) => name !== key))
      expect(() => commands.parseHostProjectMemoryCommand(vector.operation, body)).toThrow()
    }
    expect(() => commands.parseHostProjectMemoryCommand(vector.operation, { ...vector.body, verified: true })).toThrow()
  }
  for (const vector of fixture.readResults) {
    for (const key of Object.keys(vector.value)) {
      const value = Object.fromEntries(Object.entries(vector.value).filter(([name]) => name !== key))
      expect(() => results.parseHostProjectMemoryReadResult(vector.operation, value)).toThrow()
    }
    expect(() =>
      results.parseHostProjectMemoryReadResult(vector.operation, { ...vector.value, verified: true }),
    ).toThrow()
  }
  for (const value of [
    null,
    [],
    Object.create(null),
    Object.defineProperty({}, 'mode', {
      get() {
        reads++
        return 'history'
      },
      enumerable: true,
    }),
  ])
    expect(() => commands.parseHostProjectMemoryCommand('prepare_snapshot', value)).toThrow()
  const hidden = Object.defineProperty({ ...command(0) }, 'mode', { value: 'history', enumerable: false })
  expect(() => commands.parseHostProjectMemoryCommand('prepare_snapshot', hidden)).toThrow()
  expect(reads).toBe(0)
})

it('keeps proof purposes, sorted versions, delivery states and paired Right fields separate', () => {
  for (const patch of [
    { purpose: 'project_operation_memory_retained_read' },
    { operation: 'apply' },
    { expiresAt: 1001 },
    { bindingGeneration: '0' },
    { scopeVersion: '9223372036854775808' },
  ])
    expect(() => wire.parseHostProjectMemorySourceProof({ ...source(), ...patch })).toThrow()
  expect(wire.encodeHostProjectMemorySourceProof({ ...source(), side: 'slark', snapshotId: null })).toMatch(/^slark\./u)
  expect(
    wire.encodeHostProjectMemoryProjectionProof({ ...projection(), servingSide: 'dsh', operation: 'evidence' }),
  ).toMatch(/^dsh\./u)
  for (const field of ['consentVersions', 'materialVersions', 'originProofDigests']) {
    const p = projection(),
      item: unknown = p[field as 'consentVersions' | 'materialVersions' | 'originProofDigests'][0]
    for (const list of [[item, item], Array(51).fill(item), [undefined], Object.assign([item], { extra: true })])
      expect(() => wire.parseHostProjectMemoryProjectionProof({ ...p, [field]: list })).toThrow()
  }
  const p = projection()
  expect(
    wire.parseHostProjectMemoryProjectionProof({
      ...p,
      consentVersions: [
        { ...p.consentVersions[0], generation: '2' },
        { ...p.consentVersions[0], generation: '10' },
      ],
      materialVersions: [
        { ...p.materialVersions[0], sourceRevision: '2' },
        { ...p.materialVersions[0], sourceRevision: '10' },
      ],
    }).materialVersions[1]?.sourceRevision,
  ).toBe('10')
  expect(() =>
    wire.parseHostProjectMemoryProjectionProof({
      ...p,
      materialVersions: [...p.materialVersions, { ...p.materialVersions[0], sourceRevision: '1' }],
    }),
  ).toThrow()
  for (const parse of [wire.parseHostProjectMemoryHostAck, wire.parseHostProjectMemoryReceipt]) {
    const value = parse === wire.parseHostProjectMemoryHostAck ? ack() : receipt()
    for (const field of ['scopeDigest', 'recipientDigest'])
      expect(() => parse({ ...value, checkpoint: { ...value.checkpoint, [field]: badDigest } })).toThrow()
  }
  const dis = receipt().dispositions[0]!
  for (const patch of [
    { rightId: null },
    { rightGeneration: null },
    { state: 'reference_only' },
    { state: 'retained', rightId: null, rightGeneration: null },
    { state: 'allowed' },
    { reason: '../secret' },
  ])
    expect(() => wire.parseHostProjectMemoryReceipt({ ...receipt(), dispositions: [{ ...dis, ...patch }] })).toThrow()
  for (const state of ['retained', 'reference_only', 'rejected', 'tombstoned']) {
    const right =
      state === 'retained' ? { rightId: dis.rightId, rightGeneration: '1' } : { rightId: null, rightGeneration: null }
    expect(
      wire.parseHostProjectMemoryReceipt({
        ...receipt(),
        stage: 'reconciliation_only',
        dispositions: [{ ...dis, ...right, state, reason: 'reason_1' }],
      }).stage,
    ).toBe('reconciliation_only')
  }
  for (const input of [directive(), projection(), ack(), receipt()]) {
    expect(() => wire.parseHostProjectMemorySourceProof(input)).toThrow()
  }
})

it('validates all command alternatives, exact scan positions, byte budgets and query text', () => {
  expect(commands.parseHostProjectMemoryCommand('prepare_snapshot', { ...command(0), mode: 'delta' })).toHaveProperty(
    'mode',
    'delta',
  )
  for (const resumeOperation of ['history_page', 'delta_page', 'search']) {
    const c = {
      ...command(1),
      resumeOperation,
      snapshotId: resumeOperation === 'delta_page' ? null : 'snapshot_1',
      queryDigest: resumeOperation === 'search' ? badDigest : null,
    }
    expect(commands.parseHostProjectMemoryCommand('prepare_snapshot', c)).toEqual(c)
  }
  for (const patch of [
    { mode: 'all' },
    { journalEpoch: 'other' },
    { throughSequence: '0', checkpoint: { ...command(1).checkpoint, sequence: '1' } },
    { snapshotId: null },
    { queryDigest: badDigest },
  ])
    expect(() => commands.parseHostProjectMemoryCommand('prepare_snapshot', { ...command(1), ...patch })).toThrow()
  for (const op of ['history_page', 'delta_page'] as const) {
    const c = command(op === 'history_page' ? 2 : 3)
    expect(
      commands.parseHostProjectMemoryCommand(op, {
        ...c,
        afterCursor: 'AA',
        throughSequence: '9223372036854775807',
        pageSize: 1,
        maxBytes: 1024,
      }),
    ).toHaveProperty('afterCursor', 'AA')
    for (const patch of [
      { throughSequence: '9223372036854775808' },
      { throughSequence: '00' },
      { pageSize: 0 },
      { pageSize: 51 },
      { maxBytes: 1023 },
      { maxBytes: 32769 },
      { afterCursor: 'AB' },
      { afterCursor: '' },
      { afterCursor: 'A'.repeat(4097) },
    ])
      expect(() => commands.parseHostProjectMemoryCommand(op, { ...c, ...patch })).toThrow()
  }
  expect(commands.hostProjectMemoryQueryDigest('目标')).not.toBe(commands.hostProjectMemoryQueryDigest(' 目标'))
  for (const query of ['', '\ud800', '界'.repeat(683), null])
    expect(() => commands.hostProjectMemoryQueryDigest(query)).toThrow()
  for (const patch of [{ query: 'different' }, { limit: 0 }, { limit: 21 }, { maxBytes: 32769 }, { cursor: 'AB' }])
    expect(() => commands.parseHostProjectMemoryCommand('search', { ...command(4), ...patch })).toThrow()
  expect(
    commands.parseHostProjectMemoryCommand('evidence', {
      ...command(5),
      rightId: id2,
      rightGeneration: '1',
      offset: 1048576,
      maxBytes: 1,
    }),
  ).toHaveProperty('rightId', id2)
  for (const patch of [
    { rightId: id2 },
    { rightGeneration: '1' },
    { offset: 1048577 },
    { maxBytes: 0 },
    { maxBytes: 16385 },
  ])
    expect(() => commands.parseHostProjectMemoryCommand('evidence', { ...command(5), ...patch })).toThrow()
  for (const patch of [
    { phase: 'wrong' },
    { sourceProofDigest: badDigest },
    { readDirectiveDigest: badDigest },
    { expectedCheckpoint: { ...command(6).expectedCheckpoint, scopeDigest: badDigest } },
    { expectedCheckpoint: { ...command(6).expectedCheckpoint, recipientDigest: badDigest } },
    { expectedCheckpoint: { ...command(6).expectedCheckpoint, journalEpoch: 'other' } },
    { events: Array(51).fill(fixture.event) },
  ])
    expect(() => commands.parseHostProjectMemoryCommand('apply', { ...command(6), ...patch })).toThrow()
  for (const field of ['deliveryId', 'batchId', 'batchDigest'])
    expect(() =>
      commands.parseHostProjectMemoryCommand('apply', {
        ...command(7),
        [field]: field === 'batchDigest' ? badDigest : id2,
      }),
    ).toThrow()
  for (const op of ['unknown', null, 1]) {
    expect(() => commands.parseHostProjectMemoryCommand(op, {})).toThrow()
    expect(() => commands.hostProjectMemoryCommandDigest(op, {})).toThrow()
    expect(() => results.parseHostProjectMemoryReadResult(op, {})).toThrow()
  }
  expect(() =>
    commands.hostProjectMemoryBatchDigest({ ...fixture.batch.context, direction: 'wrong' }, command(6)),
  ).toThrow()
  expect(() => commands.hostProjectMemoryBatchDigest(fixture.batch.context, command(7))).toThrow()
})

it('cross-binds requests, scopes, original event identities and batch bytes', () => {
  for (const vector of fixture.commands)
    expect(commands.parseHostProjectMemoryRequest(request(vector.operation, vector.body)).commandBody).toEqual(
      vector.body,
    )
  expect(() =>
    commands.parseHostProjectMemoryRequest(request('prepare_snapshot', command(0), { commandDigest: badDigest })),
  ).toThrow()
  for (const patch of [{ requestId: id2 }, { expectedScopeVersion: '2' }])
    expect(() =>
      commands.parseHostProjectMemoryRequest(request('prepare_snapshot', { ...command(0), ...patch })),
    ).toThrow()
  for (const field of ['scopeDigest', 'recipientDigest'])
    expect(() =>
      commands.parseHostProjectMemoryRequest(
        request('prepare_snapshot', { ...command(1), checkpoint: { ...command(1).checkpoint, [field]: badDigest } }),
      ),
    ).toThrow()
  expect(() => commands.parseHostProjectMemoryRequest(request('apply', command(6), { peer: null }))).toThrow()
  for (const field of [
    'authorityEnvironmentId',
    'bindingId',
    'bindingGeneration',
    'scopeVersion',
    'scopeDigest',
    'recipientDigest',
  ]) {
    const c = command(7),
      p = c.cloudMaterialReceipt
    Object.assign(p, {
      [field]:
        field === 'authorityEnvironmentId' || field === 'bindingId' ? id2 : field.endsWith('Digest') ? badDigest : '2',
    })
    if (field === 'scopeDigest' || field === 'recipientDigest')
      Object.assign(p.checkpoint, { [field]: Reflect.get(p, field) })
    expect(() => commands.parseHostProjectMemoryRequest(request('apply', c))).toThrow()
  }
  for (const patch of [{ side: 'slark' }, { sourceActorRef: 'other' }]) {
    const c = command(6)
    c.sourceProof = { ...c.sourceProof, ...patch }
    c.sourceProofDigest = wire.hostProjectMemorySourceProofDigest(c.sourceProof)
    c.batchDigest = commands.hostProjectMemoryBatchDigest(fixture.batch.context, c)
    expect(() => commands.parseHostProjectMemoryRequest(request('apply', c))).toThrow()
  }
  for (const patch of [
    { originSide: 'slark' },
    { originActorRef: 'other' },
    { projectId: 'other' },
    { kind: 'experience' },
  ]) {
    const c = command(6),
      { payloadDigest: _digest, ...fields } = fixture.event
    Object.assign(c, { events: [createHostProjectOperationEvent({ ...fields, ...patch })] })
    c.batchDigest = commands.hostProjectMemoryBatchDigest(fixture.batch.context, c)
    expect(() => commands.parseHostProjectMemoryRequest(request('apply', c))).toThrow()
  }
  expect(() =>
    commands.parseHostProjectMemoryRequest(request('apply', { ...command(6), participantRole: 'recipient_import' })),
  ).toThrow()
  expect(() =>
    commands.parseHostProjectMemoryRequest(request('apply', { ...command(6), batchDigest: badDigest })),
  ).toThrow()
  const offer = JSON.parse(readFileSync(new URL('./fixtures/twin-binding-offer-v1.json', import.meta.url), 'utf8')) as {
    offer: { directions: [{ scope: unknown }, { scope: wire.HostProjectMemoryDirective['scope'] }] }
  }
  const s = offer.offer.directions[1].scope,
    d = { ...directive(), scope: s, direction: 'slark_to_dsh' },
    c = command(6)
  c.participantRole = 'recipient_import'
  c.events = []
  c.sourceProof = {
    ...c.sourceProof,
    side: 'slark',
    sourceActorRef: s.sourceRef.actorRef,
    scopeDigest: s.scopeDigest,
    recipientDigest: commands.hostProjectMemoryRecipientDigest(wire.parseHostProjectMemoryDirective(d)),
  }
  c.expectedCheckpoint = {
    ...c.expectedCheckpoint,
    scopeDigest: c.sourceProof.scopeDigest,
    recipientDigest: c.sourceProof.recipientDigest,
  }
  c.sourceProofDigest = wire.hostProjectMemorySourceProofDigest(c.sourceProof)
  c.batchDigest = commands.hostProjectMemoryBatchDigest(
    { direction: 'slark_to_dsh', scopeDigest: s.scopeDigest, recipientDigest: c.sourceProof.recipientDigest },
    c,
  )
  expect(
    commands.parseHostProjectMemoryRequest(request('apply', c, { scope: s, direction: 'slark_to_dsh' })).commandBody,
  ).toEqual(c)
})

it('checks prepare/page scan boundaries, explicit gaps, empty logs and complete result byte limits', () => {
  const zero = result(0)
  zero.snapshotId = null
  zero.historyCut = { from: null, to: null, timeZone: 'UTC' }
  zero.throughSequence = '0'
  zero.coverage.throughSequence = '0'
  expect(results.parseHostProjectMemoryReadResult('prepare_snapshot', zero)).toEqual(zero)
  for (const patch of [
    { journalEpoch: 'other' },
    { coverage: { ...result(0).coverage, throughSequence: '2' } },
    { checkpoint: { ...result(0).checkpoint, sequence: '2' } },
    { syncStartSequence: '2' },
    { activationSequence: '2' },
    { historyCut: { from: 200, to: 100, timeZone: 'UTC' } },
    { historyCut: { from: null, to: null, timeZone: 'Invalid/Zone' } },
  ])
    expect(() => results.parseHostProjectMemoryReadResult('prepare_snapshot', { ...result(0), ...patch })).toThrow()
  for (const reason of ['history_not_selected', 'source_unavailable', 'provider_unsupported', 'version_gap']) {
    const c = { ...result(0).coverage, state: 'partial', gaps: [{ fromSequence: '0', toSequence: '1', reason }] }
    expect(results.parseHostProjectMemoryReadResult('prepare_snapshot', { ...result(0), coverage: c })).toHaveProperty(
      'coverage',
      c,
    )
  }
  expect(
    results.parseHostProjectMemoryReadResult('prepare_snapshot', {
      ...result(0),
      coverage: { ...result(0).coverage, state: 'unsupported' },
    }),
  ).toHaveProperty('coverage.state', 'unsupported')
  for (const patch of [
    { fromSequence: '1' },
    { scannedThroughSequence: '2' },
    { gaps: [{ fromSequence: '1', toSequence: '0', reason: 'version_gap' }] },
    { gaps: [{ fromSequence: '0', toSequence: '2', reason: 'version_gap' }] },
    {
      fromSequence: '1',
      scannedThroughSequence: '1',
      gaps: [{ fromSequence: '0', toSequence: '1', reason: 'version_gap' }],
    },
    { gaps: [{ fromSequence: '0', toSequence: '1', reason: 'invented' }] },
    { gaps: Array(21).fill({ fromSequence: '0', toSequence: '1', reason: 'version_gap' }) },
  ])
    expect(() =>
      results.parseHostProjectMemoryReadResult('prepare_snapshot', {
        ...result(0),
        coverage: { ...result(0).coverage, ...patch },
      }),
    ).toThrow()
  const pg = result(1)
  expect(results.parseHostProjectMemoryReadResult('history_page', { ...pg, events: [] })).toHaveProperty('eof', true)
  const more = {
    ...pg,
    throughSequence: '2',
    nextCursor: 'AA',
    eof: false,
    coverage: { ...pg.coverage, throughSequence: '2' },
  }
  expect(results.parseHostProjectMemoryReadResult('delta_page', more)).toHaveProperty('eof', false)
  for (const patch of [
    { checkpoint: { ...pg.checkpoint, sequence: '0' } },
    { coverage: { ...pg.coverage, scannedThroughSequence: '0' } },
    { coverage: { ...pg.coverage, throughSequence: '2' } },
    { nextCursor: 'AA' },
    { eof: false },
    { eof: 'true' },
    { throughSequence: '2', coverage: { ...pg.coverage, throughSequence: '2' } },
    { ...more, throughSequence: '1', coverage: pg.coverage },
    {
      scannedThroughSequence: '0',
      checkpoint: { ...pg.checkpoint, sequence: '0' },
      coverage: { ...pg.coverage, scannedThroughSequence: '0' },
      nextCursor: 'AA',
      eof: false,
    },
    { events: [fixture.event, fixture.event] },
  ])
    expect(() => results.parseHostProjectMemoryReadResult('history_page', { ...pg, ...patch })).toThrow()
  const { payloadDigest: _digest, ...fields } = fixture.event
  const next = createHostProjectOperationEvent({ ...fields, sourceSequence: '2' })
  expect(
    results.parseHostProjectMemoryReadResult('history_page', {
      ...pg,
      events: [fixture.event, next],
      scannedThroughSequence: '2',
      throughSequence: '2',
      checkpoint: { ...pg.checkpoint, sequence: '2' },
      coverage: { ...pg.coverage, scannedThroughSequence: '2', throughSequence: '2' },
    }),
  ).toHaveProperty('events.length', 2)
  const large = createHostProjectOperationEvent({
    ...fields,
    content: {
      ...fields.content,
      goalSummary: 'x'.repeat(2000),
      operationSummary: 'y'.repeat(2000),
      resultSummary: 'z'.repeat(2000),
    },
  })
  const events = Array.from({ length: 6 }, (_, i) =>
    createHostProjectOperationEvent({ ...fields, sourceSequence: String(i + 1), content: large.content }),
  )
  expect(() =>
    results.parseHostProjectMemoryReadResult('history_page', {
      ...pg,
      events,
      scannedThroughSequence: '6',
      throughSequence: '6',
      checkpoint: { ...pg.checkpoint, sequence: '6' },
      coverage: { ...pg.coverage, scannedThroughSequence: '6', throughSequence: '6' },
    }),
  ).toThrow()
  expect(() => commands.parseHostProjectMemoryCommand('apply', { ...command(6), events })).toThrow()
})

it('checks search material revisions and evidence chunk bytes independently of proof claims', () => {
  const s = result(3)
  expect(
    results.parseHostProjectMemoryReadResult('search', {
      ...s,
      items: [{ ...s.items[0], rightId: null, rightGeneration: null }],
      materialVersions: [],
    }),
  ).toHaveProperty('materialVersions.length', 0)
  for (const patch of [
    { resumeRef: { ...s.resumeRef, snapshotId: 'other' } },
    { resumeRef: { ...s.resumeRef, journalEpoch: 'other' } },
    { resumeRef: { ...s.resumeRef, throughSequence: '2' } },
    { resumeRef: { ...s.resumeRef, checkpoint: { ...s.resumeRef.checkpoint, sequence: '2' } } },
    { items: [{ ...s.items[0], rightId: null }] },
    { items: [{ ...s.items[0], rightGeneration: '2' }] },
    { items: [{ ...s.items[0], sourceRevision: '2' }] },
    { items: [{ ...s.items[0], rightId: id2 }] },
    { materialVersions: [] },
    { items: [{ ...s.items[0], snippet: '界'.repeat(683) }] },
    { items: [{ ...s.items[0], snippet: '\ud800' }] },
    { items: Array(21).fill(s.items[0]) },
  ])
    expect(() => results.parseHostProjectMemoryReadResult('search', { ...s, ...patch })).toThrow()
  const r = result(4)
  for (const patch of [
    { status: 'unknown' },
    { offset: 7 },
    { totalBytes: 5 },
    { chunkDigest: badDigest },
    { payloadDigest: badDigest },
    { nextOffset: 6 },
    { totalBytes: 7 },
    { eof: false },
    { eof: false, nextOffset: 6 },
    { bytesBase64url: 'AB' },
    { bytesBase64url: 'AA==' },
    { bytesBase64url: 'A'.repeat(21847) },
    { offset: 1048577 },
    { nextOffset: 1048577 },
  ])
    expect(() => results.parseHostProjectMemoryReadResult('evidence', { ...r, ...patch })).toThrow()
  expect(
    results.parseHostProjectMemoryReadResult('evidence', { ...r, totalBytes: 7, nextOffset: 6, eof: false }),
  ).toHaveProperty('nextOffset', 6)
  expect(
    results.parseHostProjectMemoryReadResult('evidence', { ...r, offset: 1, totalBytes: 7, payloadDigest: badDigest }),
  ).toHaveProperty('offset', 1)
  const empty = createHash('sha256').update('').digest('hex')
  expect(
    results.parseHostProjectMemoryReadResult('evidence', {
      ...r,
      payloadDigest: empty,
      chunkDigest: empty,
      bytesBase64url: '',
      totalBytes: 0,
    }),
  ).toHaveProperty('eof', true)
  expect(() =>
    results.parseHostProjectMemoryReadResult('evidence', {
      ...r,
      chunkDigest: empty,
      bytesBase64url: '',
      eof: false,
      nextOffset: 0,
    }),
  ).toThrow()
})

it('accepts source and retained envelopes while refusing ambiguous proofs and cross-purpose claims', () => {
  for (const [i, operation] of [
    'prepare_snapshot',
    'history_page',
    'delta_page',
    'search',
    'evidence',
    'evidence',
  ].entries())
    assertEnvelope(operation as wire.HostProjectMemoryReadOperation, result(i))
  assertEnvelope('search', result(3), 'projection')
  const evidenceCommand = {
    ...command(5),
    rightId: fixture.receiptResult.cloudMaterialReceipt.dispositions[0]!.rightId,
    rightGeneration: '1',
  }
  assertEnvelope('evidence', result(4), 'projection', evidenceCommand)
  assertEnvelope('evidence', { status: 'missing' }, 'projection')
  const e = envelope('prepare_snapshot', result(0))
  for (const patch of [
    { status: 'other' },
    { operation: 'search' },
    { sourceProof: null },
    { projectionProof: projection() },
    { sourceProof: { ...e.value.sourceProof, operation: 'search' } },
    ...['authorityEnvironmentId', 'readDirectiveDigest', 'scopeDigest', 'recipientDigest', 'resultDigest'].map(
      field => ({
        sourceProof: { ...e.value.sourceProof, [field]: field === 'authorityEnvironmentId' ? id2 : badDigest },
      }),
    ),
    { sourceProof: { ...e.value.sourceProof, issuedAt: 999 } },
    { sourceProof: { ...e.value.sourceProof, expiresAt: 16001 } },
    ...['side', 'sourceActorRef', 'bindingId', 'bindingGeneration', 'scopeVersion'].map(field => ({
      sourceProof: {
        ...e.value.sourceProof,
        [field]: field === 'side' ? 'slark' : field === 'bindingId' ? id2 : field === 'sourceActorRef' ? 'other' : '2',
      },
    })),
    { sourceProof: { ...e.value.sourceProof, journalEpoch: 'other' } },
    { sourceProof: { ...e.value.sourceProof, snapshotId: 'other' } },
  ])
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, { ...e.value, ...patch })).toThrow()
  for (const code of [
    'unauthorized',
    'binding_inactive',
    'scope_changed',
    'source_changed',
    'material_revoked',
    'journal_epoch_changed',
    'cursor_invalid',
    'cursor_expired',
    'capability_unavailable',
    'payload_too_large',
    'conflict',
    'timeout',
  ])
    expect(
      results.parseHostProjectMemoryReadEnvelope(e.req, {
        status: 'error',
        code,
        requestId: e.req.directive.requestId,
        retryable: false,
      }),
    ).toHaveProperty('code', code)
  expect(() =>
    results.parseHostProjectMemoryReadEnvelope(e.req, {
      status: 'error',
      code: 'timeout',
      requestId: id2,
      retryable: true,
    }),
  ).toThrow()
  expect(() =>
    results.parseHostProjectMemoryReadEnvelope(e.req, {
      status: 'error',
      code: 'secret_error',
      requestId: e.req.directive.requestId,
      retryable: true,
    }),
  ).toThrow()
  for (const op of ['apply', 'receipt'] as const)
    expect(() =>
      results.parseHostProjectMemoryReadEnvelope(request(op, command(op === 'apply' ? 6 : 8)), e.value),
    ).toThrow()
})

it('binds snapshot activation/resume to the immutable original cut and scope', () => {
  for (const field of ['scopeDigest', 'recipientDigest']) {
    const r = result(0)
    Object.assign(r.checkpoint, { [field]: badDigest })
    const e = envelope('prepare_snapshot', r)
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  }
  for (const historyCut of [
    { from: 99, to: 200, timeZone: 'UTC' },
    { from: 100, to: 201, timeZone: 'UTC' },
    { from: 100, to: 200, timeZone: 'Etc/UTC' },
  ]) {
    const e = envelope('prepare_snapshot', { ...result(0), historyCut })
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  }
  for (const patch of [{ resumeCursor: 'AA' }, { snapshotId: null }]) {
    const e = envelope('prepare_snapshot', { ...result(0), ...patch })
    e.value.sourceProof!.snapshotId = patch.snapshotId === null ? null : 'snapshot_1'
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  }
  const delta = envelope('prepare_snapshot', { ...result(0), snapshotId: null }, 'source', {
    ...command(0),
    mode: 'delta',
  })
  delta.value.sourceProof!.snapshotId = null
  expect(results.parseHostProjectMemoryReadEnvelope(delta.req, delta.value)).toEqual(delta.value)
  const resumed = { ...result(0), resumeCursor: 'AA' }
  assertEnvelope('prepare_snapshot', resumed, 'source', command(1))
  for (const patch of [
    { resumeCursor: null },
    { journalEpoch: 'other', checkpoint: { ...resumed.checkpoint, journalEpoch: 'other' } },
    { snapshotId: 'other' },
    { throughSequence: '2', coverage: { ...resumed.coverage, throughSequence: '2' } },
    { checkpoint: { ...resumed.checkpoint, sequence: '1' } },
  ]) {
    const r = { ...resumed, ...patch },
      e = envelope('prepare_snapshot', r, 'source', command(1))
    e.value.sourceProof!.snapshotId = r.snapshotId
    e.value.sourceProof!.journalEpoch = r.journalEpoch
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  }
  const projected = envelope('search', result(3), 'projection')
  projected.value.operation = 'prepare_snapshot'
  projected.value.result = result(0)
  projected.req = request('prepare_snapshot', command(0))
  expect(() => results.parseHostProjectMemoryReadEnvelope(projected.req, projected.value)).toThrow()
})

it('requires exact previous page progress, source coordinates and requested output bounds', () => {
  const base = result(1),
    prev = fixture.commands[1].body.checkpoint
  const e = envelope('history_page', base)
  expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  for (const previousCheckpoint of [
    { ...prev, scopeDigest: badDigest },
    { ...prev, recipientDigest: badDigest },
    { ...prev, journalEpoch: 'other' },
    { ...prev, sequence: '2' },
  ])
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value, { previousCheckpoint })).toThrow()
  const more = {
    ...base,
    throughSequence: '2',
    nextCursor: 'AA',
    eof: false,
    coverage: { ...base.coverage, throughSequence: '2' },
  }
  assertEnvelope('history_page', more, 'source', { ...command(2), throughSequence: '2' })
  const stagnant = {
    ...more,
    events: [],
    scannedThroughSequence: '0',
    checkpoint: prev,
    coverage: { ...more.coverage, scannedThroughSequence: '0' },
  }
  const st = envelope('history_page', stagnant, 'source', { ...command(2), throughSequence: '2' })
  expect(() => results.parseHostProjectMemoryReadEnvelope(st.req, st.value, { previousCheckpoint: prev })).toThrow()
  for (const body of [
    { ...command(2), journalEpoch: 'other' },
    { ...command(2), throughSequence: '2' },
    { ...command(2), snapshotId: 'other' },
  ]) {
    const changed = envelope('history_page', base, 'source', body)
    expect(() =>
      results.parseHostProjectMemoryReadEnvelope(changed.req, changed.value, { previousCheckpoint: prev }),
    ).toThrow()
  }
  const { payloadDigest: _digest, ...fields } = fixture.event
  for (const patch of [
    { sourceSequence: '0' },
    { originSide: 'slark' },
    { originActorRef: 'other' },
    { projectId: 'other' },
    { kind: 'experience' },
    { occurredAt: 99 },
    { occurredAt: 201 },
  ]) {
    const changed = envelope('history_page', {
      ...base,
      events: [createHostProjectOperationEvent({ ...fields, ...patch })],
    })
    expect(() =>
      results.parseHostProjectMemoryReadEnvelope(changed.req, changed.value, { previousCheckpoint: prev }),
    ).toThrow()
  }
  const outside = envelope('delta_page', {
    ...base,
    events: [createHostProjectOperationEvent({ ...fields, occurredAt: 99 })],
  })
  expect(results.parseHostProjectMemoryReadEnvelope(outside.req, outside.value, { previousCheckpoint: prev })).toEqual(
    outside.value,
  )
  const two = {
    ...base,
    events: [fixture.event, createHostProjectOperationEvent({ ...fields, sourceSequence: '2' })],
    throughSequence: '2',
    scannedThroughSequence: '2',
    checkpoint: { ...prev, sequence: '2' },
    coverage: { ...base.coverage, throughSequence: '2', scannedThroughSequence: '2' },
  }
  const tooMany = envelope('history_page', two, 'source', { ...command(2), throughSequence: '2', pageSize: 1 })
  expect(() =>
    results.parseHostProjectMemoryReadEnvelope(tooMany.req, tooMany.value, { previousCheckpoint: prev }),
  ).toThrow()
  const small = envelope('history_page', base, 'source', { ...command(2), maxBytes: 1024 })
  expect(Buffer.byteLength(JSON.stringify(base))).toBeGreaterThan(1024)
  expect(() =>
    results.parseHostProjectMemoryReadEnvelope(small.req, small.value, { previousCheckpoint: prev }),
  ).toThrow()
  const wrongEpoch = envelope('history_page', { ...base, checkpoint: { ...base.checkpoint, journalEpoch: 'other' } })
  wrongEpoch.value.sourceProof!.journalEpoch = 'other'
  expect(() =>
    results.parseHostProjectMemoryReadEnvelope(wrongEpoch.req, wrongEpoch.value, {
      previousCheckpoint: { ...prev, journalEpoch: 'other' },
    }),
  ).toThrow()
})

it('binds retained search and evidence to exact material versions and requested byte offsets', () => {
  const s = result(3)
  for (const patch of [
    { resumeRef: { ...s.resumeRef, queryDigest: badDigest } },
    { items: [{ ...s.items[0], kind: 'experience' }] },
    { items: [{ ...s.items[0], originSide: 'slark' }] },
    { items: [{ ...s.items[0], originActorRef: 'other' }] },
  ]) {
    const e = envelope('search', { ...s, ...patch })
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  }
  const e = envelope('search', s)
  e.value.sourceProof!.snapshotId = 'other'
  expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  const retained = envelope('search', s, 'projection')
  retained.value.projectionProof!.materialVersions = []
  expect(() => results.parseHostProjectMemoryReadEnvelope(retained.req, retained.value)).toThrow()
  const many = envelope('search', { ...s, items: [s.items[0], s.items[0]] }, 'source', { ...command(4), limit: 1 })
  expect(() => results.parseHostProjectMemoryReadEnvelope(many.req, many.value)).toThrow()
  const large = envelope('search', { ...s, items: [{ ...s.items[0], snippet: 'x'.repeat(2048) }] }, 'source', {
    ...command(4),
    maxBytes: 1024,
  })
  expect(() => results.parseHostProjectMemoryReadEnvelope(large.req, large.value)).toThrow()
  const r = result(4)
  for (const patch of [{ sourceEventId: 'other' }, { sourceRevision: '2' }, { offset: 1, totalBytes: 7 }]) {
    const e = envelope('evidence', { ...r, ...patch })
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  }
  const bytes = envelope('evidence', r, 'source', { ...command(5), maxBytes: 1 })
  expect(() => results.parseHostProjectMemoryReadEnvelope(bytes.req, bytes.value)).toThrow()
  const noRight = envelope('evidence', r, 'projection')
  expect(() => results.parseHostProjectMemoryReadEnvelope(noRight.req, noRight.value)).toThrow()
  for (const patch of [
    { rightId: id2, rightGeneration: '1' },
    { rightId: s.items[0]!.rightId, rightGeneration: '2' },
    { rightId: s.items[0]!.rightId, rightGeneration: '1', sourceRevision: '2' },
  ]) {
    const c = { ...command(5), ...patch },
      changed = { ...r, sourceRevision: c.sourceRevision },
      e = envelope('evidence', changed, 'projection', c)
    expect(() => results.parseHostProjectMemoryReadEnvelope(e.req, e.value)).toThrow()
  }
})

it('parses only the Doc-defined delivery result fields and keeps staging distinct from activation', () => {
  for (const status of ['activated', 'already_activated', 'reconciliation_only'])
    for (const activatedAt of [null, 0, 1400])
      expect(
        results.parseHostProjectMemoryFinalizeResult({ ...fixture.finalizeResult, status, activatedAt }),
      ).toHaveProperty('status', status)
  expect(results.parseHostProjectMemoryReceiptResult({ status: 'missing' })).toEqual({ status: 'missing' })
  for (const effectiveState of ['staged', 'active', 'reconciliation_only'])
    for (const cloudMaterialReceipt of [null, receipt()])
      expect(
        results.parseHostProjectMemoryReceiptResult({ ...fixture.receiptResult, effectiveState, cloudMaterialReceipt }),
      ).toHaveProperty('effectiveState', effectiveState)
  for (const parse of [results.parseHostProjectMemoryFinalizeResult, results.parseHostProjectMemoryReceiptResult]) {
    const value =
      parse === results.parseHostProjectMemoryFinalizeResult ? fixture.finalizeResult : fixture.receiptResult
    for (const key of Object.keys(value)) {
      const missing = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
      expect(() => parse(missing)).toThrow()
    }
    for (const extra of [{ verified: true }, { executed: true }, { grant: true }])
      expect(() => parse({ ...value, ...extra })).toThrow()
  }
  expect(() => results.parseHostProjectMemoryFinalizeResult({ ...fixture.finalizeResult, status: 'active' })).toThrow()
  expect(() =>
    results.parseHostProjectMemoryReceiptResult({ ...fixture.receiptResult, effectiveState: 'activated' }),
  ).toThrow()
})

it('encodes explicit gaps, live locators, dependencies and tombstones without acquiring their rights', () => {
  const r = result(0)
  r.coverage.gaps = [{ fromSequence: '0', toSequence: '1', reason: 'version_gap' }]
  expect(results.hostProjectMemoryReadResultDigest('prepare_snapshot', r)).not.toBe(fixture.readResults[0].digest)
  const { payloadDigest: _digest, ...fields } = fixture.event
  const dependency = { rightId: id2, generation: '2', revision: '3' }
  const fact = createHostProjectOperationEvent({ ...fields, materialDependencies: [dependency] })
  const live = createHostProjectOperationEvent({
    ...fields,
    sourcePolicy: 'live_reference_v1',
    content: null,
    sourceLocator: {
      providerId: 'provider_1',
      sourceEventId: fields.sourceEventId,
      sourceRevision: fields.sourceRevision,
      sourceDigest: badDigest,
    },
  })
  const tombstone = createHostProjectOperationEvent({ ...fields, kind: 'tombstone', content: null })
  for (const event of [fact, live, tombstone])
    expect(commands.hostProjectMemoryCommandDigest('apply', { ...command(6), events: [event] })).not.toBe(
      fixture.commands[6].digest,
    )
  const e = envelope('search', result(3), 'projection')
  e.req = request('history_page', command(2))
  e.value.operation = 'history_page'
  e.value.result = result(1)
  expect(() =>
    results.parseHostProjectMemoryReadEnvelope(e.req, e.value, {
      previousCheckpoint: fixture.commands[1].body.checkpoint,
    }),
  ).toThrow()
})
