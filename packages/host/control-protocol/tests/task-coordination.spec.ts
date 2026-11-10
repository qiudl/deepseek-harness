/** Pure wire tests; no execution, signing service, carrier or floor authority is installed. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { verify } from 'node:crypto'
import { it } from 'vitest'
import * as codec from '../src/task-coordination.ts'

type Mutable<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T
type Entry<O extends codec.HostTaskCoordinationCommands['operation']> = {
  directive: Mutable<codec.HostTaskCoordinationDirective>
  command: Mutable<Extract<codec.HostTaskCoordinationCommands, { operation: O }>>
}
type Good<S extends 'attached' | 'closed' | 'observed' | 'missing' | 'found'> = {
  ok: true
  peer: Mutable<codec.HostTaskCoordinationPeer>
  record: Mutable<Extract<Extract<codec.HostTaskCoordinationReply, { ok: true }>['record'], { status: S }>>
}
type Fixture = {
  inventoryGoldens: { twoItemsDigest: string; full51Digest: string; emptyDigest: string }
  inputs: [
    Entry<'attach'>,
    Entry<'attach'>,
    Entry<'attach'>,
    Entry<'attach'>,
    Entry<'attach'>,
    Entry<'attach'>,
    Entry<'attach'>,
    Entry<'attach'>,
    Entry<'fence'>,
    Entry<'observe'>,
    Entry<'observe'>,
    Entry<'receipt'>,
    Entry<'receipt'>,
  ]
  goldens: {
    directivePreimage: string
    directiveDigest: string
    scopeDigest: string
    floorDigest: string
    commandDigest: string
  }[]
  fenceAcks: Mutable<codec.HostTaskCoordinationFenceAck>[]
  observations: [Mutable<codec.HostTaskCoordinationObservation>, Mutable<codec.HostTaskCoordinationObservation>]
  replies: [
    Good<'attached'>,
    Good<'closed'>,
    Good<'observed'>,
    Good<'found'>,
    Good<'missing'>,
    ...Mutable<Extract<codec.HostTaskCoordinationReply, { ok: false }>>[],
  ]
  ackPreimages: string[]
  observationPreimages: string[]
  publicKeys: { cloud: string; host: string }
}
const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/task-coordination-v1.json', import.meta.url), 'utf8'),
) as Fixture
function at(value: unknown, path: string[]): Record<string, unknown> {
  let current: unknown = value
  for (const key of path) {
    assert(current !== null && typeof current === 'object')
    current = Object.getOwnPropertyDescriptor(current, key)?.value
  }
  assert(current !== null && typeof current === 'object')
  return current as Record<string, unknown>
}
const copy = <T>(value: T): T => structuredClone(value)
const uuid = 'ffffffff-1111-4111-8111-ffffffffffff'
const signed = (preimage: string, signature: string, key: string) =>
  verify(null, Buffer.from(preimage), key, Buffer.from(signature, 'base64url'))

it('pins independently constructed literal bytes for all eight grant families and four operations', () => {
  assert.equal(codec.HOST_TASK_COORDINATION_AUDIENCE, 'urn:slark:task-coordination:v1')
  assert.equal(vectors.inputs.length, 13)
  for (let i = 0; i < vectors.inputs.length; i++) {
    const input = codec.parseHostTaskCoordinationInput(vectors.inputs[i]),
      golden = vectors.goldens[i]!
    assert.deepEqual(input, vectors.inputs[i])
    assert.equal(codec.encodeHostTaskCoordinationDirective(input.directive), golden.directivePreimage)
    assert.equal(codec.hostTaskCoordinationScopeDigest(input.directive.scope), golden.scopeDigest)
    assert.equal(codec.hostTaskCoordinationFloorDigest(input.directive.scope), golden.floorDigest)
    assert.equal(codec.hostTaskCoordinationCommandDigest(input.command), golden.commandDigest)
    assert.equal(codec.hostTaskCoordinationDirectiveDigest(input.directive), golden.directiveDigest)
    assert(signed(golden.directivePreimage, input.directive.signature, vectors.publicKeys.cloud))
    assert(Object.isFrozen(input) && Object.isFrozen(input.directive) && Object.isFrozen(input.command))
  }
})
it('pins historical fence Ack and current observation bytes and real Ed25519 signatures', () => {
  vectors.fenceAcks.forEach((value: unknown, i: number) => {
    const ack = codec.parseHostTaskCoordinationFenceAck(value)
    assert.equal(codec.encodeHostTaskCoordinationFenceAck(value), vectors.ackPreimages[i]!)
    assert(signed(vectors.ackPreimages[i]!, ack.signature, vectors.publicKeys.host))
    assert(!signed(vectors.ackPreimages[i]!, ack.signature, vectors.publicKeys.cloud))
  })
  vectors.observations.forEach((value: unknown, i: number) => {
    const observation = codec.parseHostTaskCoordinationObservation(value)
    assert.equal(codec.encodeHostTaskCoordinationObservation(value), vectors.observationPreimages[i]!)
    assert(signed(vectors.observationPreimages[i]!, observation.signature, vectors.publicKeys.host))
  })
  for (const reply of vectors.replies) assert.deepEqual(codec.parseHostTaskCoordinationReply(reply), reply)
})
it('excludes coordinator and epochs from the permanent floor, retaining both environment identities', () => {
  const original = vectors.inputs[0].directive.scope,
    next = copy(original)
  next.expectedCoordinationEpoch = '9007199254740994'
  next.acceptedCoordinationEpoch = '9007199254740995'
  next.fromCoordinatorRef = { side: 'slark', project_id: next.projectId, twin_agent_id: 'twin-2' }
  assert.equal(codec.hostTaskCoordinationFloorDigest(original), codec.hostTaskCoordinationFloorDigest(next))
  assert.notEqual(codec.hostTaskCoordinationScopeDigest(original), codec.hostTaskCoordinationScopeDigest(next))
  const changes = [
    { authorityEnvironmentId: uuid },
    { environmentKey: 'production' },
    { ownerUserId: 'owner-2' },
    { accountIssuer: 'https://second.example.test' },
    { accountSubject: 'subject-2' },
    { projectId: 'project-2' },
    { bindingId: uuid },
    { bindingGeneration: '8' },
    { canonicalRef: { ...original.canonicalRef, root_task_id: uuid } },
    { hostProfileId: uuid, fromCoordinatorRef: { ...original.fromCoordinatorRef, host_profile_id: uuid } },
    { botId: 'bot_2', fromCoordinatorRef: { ...original.fromCoordinatorRef, bot_root_id: 'bot_2' } },
  ]
  for (const change of changes)
    assert.notEqual(
      codec.hostTaskCoordinationFloorDigest({ ...original, ...change }),
      codec.hostTaskCoordinationFloorDigest(original),
    )
})
it('binds current account handle and peer in the directive without rekeying the floor', () => {
  const original = vectors.inputs[0].directive,
    changed = copy(original)
  changed.accountBindingId = 'new-handle'
  changed.accountBindingVersion = 4
  changed.peer.processNonce = Buffer.alloc(32, 51).toString('base64url')
  assert.equal(codec.hostTaskCoordinationFloorDigest(changed.scope), original.floorDigest)
  assert.notEqual(
    codec.hostTaskCoordinationDirectiveDigest(changed),
    codec.hostTaskCoordinationDirectiveDigest(original),
  )
  assert(!signed(codec.encodeHostTaskCoordinationDirective(changed), original.signature, vectors.publicKeys.cloud))
})
it('preserves original Ack signature and process peer inside a genuinely fresh outer reply', () => {
  const reply = codec.parseHostTaskCoordinationReply(vectors.replies[3])
  assert(reply.ok && reply.record.status === 'found')
  assert.notEqual(reply.peer.processNonce, reply.record.fenceAck.peer.processNonce)
  assert.equal(codec.encodeHostTaskCoordinationFenceAck(reply.record.fenceAck), vectors.ackPreimages[0])
  assert.equal(reply.record.fenceAck.signature, vectors.fenceAcks[0]!.signature)
  for (const field of ['computerId', 'installationId', 'hostRegistryId', 'publicKey'] as const) {
    const wrong = copy(vectors.replies[3])
    wrong.peer[field] =
      field === 'installationId' ? uuid : field === 'publicKey' ? Buffer.alloc(32, 61).toString('base64url') : 'changed'
    assert.throws(() => codec.parseHostTaskCoordinationReply(wrong))
  }
})
it('keeps quiescence independent of outcome and device coverage unavailable to native-complete inference', () => {
  const o = copy(vectors.observations[0])
  o.quiescence = 'quiescent'
  o.items[0]!.state = 'settled'
  o.items[0]!.disposition = 'effect_unknown'
  assert.equal(codec.parseHostTaskCoordinationObservation(o).quiescence, 'quiescent')
  assert.equal(codec.parseHostTaskCoordinationObservation(o).items[0]!.disposition, 'effect_unknown')
  for (const device of ['complete', 'unavailable', 'supported'])
    assert.throws(() => codec.parseHostTaskCoordinationObservation({ ...o, coverage: { native: 'complete', device } }))
})
it('accepts exact int64 versions above 2^53 and rejects overflow, zero, Number and noncanonical spellings', () => {
  const s = vectors.inputs[0].directive.scope
  assert.equal(codec.parseHostTaskCoordinationScope(s).expectedCoordinationEpoch, '9007199254740993')
  for (const value of ['0', '01', '-1', '9223372036854775808', '1\n', 1, null])
    assert.throws(() => codec.parseHostTaskCoordinationScope({ ...s, expectedCoordinationEpoch: value }))
  assert.equal(
    codec.parseHostTaskCoordinationScope({
      ...s,
      expectedCoordinationEpoch: '9223372036854775807',
      acceptedCoordinationEpoch: '9223372036854775807',
    }).acceptedCoordinationEpoch,
    '9223372036854775807',
  )
})
it('enforces attach equality, fence +1 and only equal/+1 observation epochs', () => {
  const attach = copy(vectors.inputs[0].directive),
    fence = copy(vectors.inputs[8].directive)
  attach.scope.acceptedCoordinationEpoch = '9007199254740994'
  attach.scopeDigest = codec.hostTaskCoordinationScopeDigest(attach.scope)
  assert.throws(() => codec.parseHostTaskCoordinationDirective(attach))
  fence.scope.acceptedCoordinationEpoch = fence.scope.expectedCoordinationEpoch
  fence.scopeDigest = codec.hostTaskCoordinationScopeDigest(fence.scope)
  assert.throws(() => codec.parseHostTaskCoordinationDirective(fence))
  assert.throws(() =>
    codec.parseHostTaskCoordinationScope({ ...attach.scope, acceptedCoordinationEpoch: '9007199254740995' }),
  )
})
it('rejects mismatched scope/project/coordinator/partition and command/digest', () => {
  const original = vectors.inputs[0],
    issue = copy(vectors.inputs[7].directive.scope)
  assert('project_id' in issue.canonicalRef)
  issue.canonicalRef.project_id = 'other'
  assert.throws(() => codec.parseHostTaskCoordinationScope(issue))
  for (const change of [{ scopeDigest: 'f'.repeat(64) }, { floorDigest: 'f'.repeat(64) }, { operation: 'receipt' }])
    assert.throws(() =>
      codec.parseHostTaskCoordinationInput({ ...original, directive: { ...original.directive, ...change } }),
    )
  const wrong = copy(original)
  wrong.command.grant.scopeId = 'project-1'
  wrong.directive.commandDigest = codec.hostTaskCoordinationCommandDigest(wrong.command)
  assert.throws(() => codec.parseHostTaskCoordinationInput(wrong))
  assert.throws(() =>
    codec.parseHostTaskCoordinationScope({
      ...original.directive.scope,
      fromCoordinatorRef: { side: 'dsh', host_profile_id: uuid, bot_root_id: 'other' },
    }),
  )
  for (const canonicalRef of [
    { ...original.directive.scope.canonicalRef, namespace_id: uuid },
    { ...original.directive.scope.canonicalRef, root_trace_id: '0'.repeat(32) },
  ])
    assert.throws(() => codec.parseHostTaskCoordinationScope({ ...original.directive.scope, canonicalRef }))
})
it('rejects cross-purpose, wrong audience/schema, unsupported command/grant and raw bodies', () => {
  const d = vectors.inputs[0].directive
  for (const change of [
    { purpose: 'project_operation_memory' },
    { purpose: 'device_task' },
    { audience: 'urn:slark:project-memory:v1' },
    { schemaVersion: 2 },
    { operation: 'open' },
  ])
    assert.throws(() => codec.parseHostTaskCoordinationDirective({ ...d, ...change }))
  assert.throws(() => codec.parseHostTaskCoordinationFenceAck(vectors.observations[0]))
  assert.throws(() => codec.parseHostTaskCoordinationObservation(vectors.fenceAcks[0]!))
  for (const extra of ['args', 'body', 'verified', 'ready', 'open', 'snapshot'])
    assert.throws(() => codec.parseHostTaskCoordinationInput({ ...vectors.inputs[0], [extra]: 'raw' }))
  assert.throws(() =>
    codec.hostTaskCoordinationCommandDigest({
      ...vectors.inputs[0].command,
      grant: { ...vectors.inputs[0].command.grant, kind: 'device' },
    }),
  )
  assert.throws(() => codec.hostTaskCoordinationCommandDigest({ operation: 'open' }))
})
it('rejects accessors at every nested input and reply boundary without invoking them', () => {
  const paths = [
    [],
    ['directive'],
    ['directive', 'scope'],
    ['directive', 'scope', 'canonicalRef'],
    ['directive', 'scope', 'fromCoordinatorRef'],
    ['directive', 'peer'],
    ['command'],
    ['command', 'grant'],
    ['command', 'localExecution'],
  ]
  for (const path of paths) {
    const input = copy(vectors.inputs[0])
    const target = at(input, path)
    const key = Object.keys(target)[0]!,
      original = target[key]
    let reads = 0
    Object.defineProperty(target, key, {
      enumerable: true,
      get: () => {
        reads++
        return original
      },
    })
    assert.throws(() => codec.parseHostTaskCoordinationInput(input))
    assert.equal(reads, 0)
  }
  const reply = copy(vectors.replies[2])
  let reads = 0
  Object.defineProperty(reply.record.observation.items, '0', {
    enumerable: true,
    get: () => {
      reads++
      return vectors.observations[0].items[0]
    },
  })
  assert.throws(() => codec.parseHostTaskCoordinationReply(reply))
  assert.equal(reads, 0)
})
it('rejects extra, symbols, nonenumerable and foreign-prototype data', () => {
  for (const target of [
    vectors.inputs[0],
    vectors.inputs[0].directive.scope,
    vectors.fenceAcks[0]!,
    vectors.observations[0],
  ]) {
    for (const malformed of [
      { ...target, extra: null },
      Object.assign(Object.create(null), target),
      Object.assign(Object.create({ inherited: true }), target),
      { ...target, [Symbol('x')]: true },
    ]) {
      const parse =
        'directive' in target
          ? codec.parseHostTaskCoordinationInput
          : 'closedAt' in target
            ? codec.parseHostTaskCoordinationFenceAck
            : 'observedAt' in target
              ? codec.parseHostTaskCoordinationObservation
              : codec.parseHostTaskCoordinationScope
      assert.throws(() => parse(malformed))
    }
  }
  const d = copy(vectors.inputs[0].directive)
  Object.defineProperty(d, 'keyId', { value: d.keyId, enumerable: false })
  assert.throws(() => codec.parseHostTaskCoordinationDirective(d))
})
it('enforces exact fifteen-second intervals, safe clocks and canonical base64url', () => {
  for (const expiresAt of [1800000000000, 1800000015001, -1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
    assert.throws(() => codec.parseHostTaskCoordinationDirective({ ...vectors.inputs[0].directive, expiresAt }))
  for (const nonce of ['A'.repeat(42) + 'B', 'A'.repeat(44), 'abc=', '\ud800'])
    assert.throws(() => codec.parseHostTaskCoordinationDirective({ ...vectors.inputs[0].directive, nonce }))
  assert.throws(() =>
    codec.parseHostTaskCoordinationObservation({ ...vectors.observations[0], observedAt: 1800000015000 }),
  )
  assert.throws(() =>
    codec.parseHostTaskCoordinationObservation({ ...vectors.observations[0], expiresAt: 1800000015001 }),
  )
})
it('preserves current observation directive binding and rejects changing it under the old signature', () => {
  const o = copy(vectors.observations[0])
  assert.equal(o.directiveDigest, vectors.goldens[9]!.directiveDigest)
  for (const change of [{ requestId: uuid }, { directiveDigest: 'f'.repeat(64) }, { scopeDigest: 'e'.repeat(64) }])
    assert(
      !signed(codec.encodeHostTaskCoordinationObservation({ ...o, ...change }), o.signature, vectors.publicKeys.host),
    )
  const reply = copy(vectors.replies[2])
  reply.peer.processNonce = Buffer.alloc(32, 44).toString('base64url')
  assert.throws(() => codec.parseHostTaskCoordinationReply(reply))
})
it('bounds pages, dense arrays, complete envelope bytes and strict result coverage', () => {
  const original = copy(vectors.observations[0])
  for (const changes of [
    { totalCount: 1 },
    { nextCursor: 'cursor', eof: true },
    { nextCursor: null, eof: false },
    { items: [original.items[0], original.items[0]] },
  ])
    assert.throws(() => codec.parseHostTaskCoordinationObservation({ ...original, ...changes }))
  const full = {
    ...original,
    totalCount: 50,
    items: Array.from({ length: 50 }, (_, i) => ({ ...original.items[1]!, itemId: 'i' + String(i) })),
  }
  assert.equal(codec.parseHostTaskCoordinationObservation(full).items.length, 50)
  assert.throws(() =>
    codec.parseHostTaskCoordinationObservation({
      ...full,
      totalCount: 51,
      items: [...full.items, { ...original.items[1]!, itemId: 'last' }],
    }),
  )
  const sparse = copy(original)
  Reflect.deleteProperty(sparse.items, '0')
  assert.throws(() => codec.parseHostTaskCoordinationObservation(sparse))
  const oversized = {
    ...full,
    items: full.items.map(i => ({
      ...i,
      commandId: 'c'.repeat(256),
      invocationId: 'i'.repeat(256),
      sessionId: 's'.repeat(256),
      jobId: 'j'.repeat(256),
    })),
  }
  assert.throws(() => codec.parseHostTaskCoordinationObservation(oversized))
  for (const pageSize of [0, 51, 1.5])
    assert.throws(() => codec.hostTaskCoordinationCommandDigest({ ...vectors.inputs[9].command, pageSize }))
  const noInventory = copy(vectors.inputs[9])
  noInventory.command.cursor = 'cursor'
  noInventory.directive.commandDigest = codec.hostTaskCoordinationCommandDigest(noInventory.command)
  assert.throws(() => codec.parseHostTaskCoordinationInput(noInventory))
})
it('requires paired persisted coordinates, preserves same callId with distinct actual item identities', () => {
  const o = copy(vectors.observations[0])
  for (const change of [{ callDigest: null }, { resultSeq: 11 }, { resultSeq: 8, resultDigest: 'e'.repeat(64) }])
    assert.throws(() => codec.parseHostTaskCoordinationObservation({ ...o, items: [{ ...o.items[0]!, ...change }] }))
  o.items = [o.items[0]!, { ...o.items[0]!, itemId: 'distinct-token-handle' }]
  assert.equal(codec.parseHostTaskCoordinationObservation(o).items.length, 2)
  for (const state of [
    'queued',
    'prepared',
    'dispatch_wait',
    'body_entered',
    'returned_not_durable',
    'settled',
    'unknown',
  ])
    assert.equal(
      codec.parseHostTaskCoordinationObservation({ ...o, items: [{ ...o.items[0]!, state }] }).items[0]!.state,
      state,
    )
  for (const bad of [
    { ok: false, errorCode: 'arbitrary message' },
    { ok: false, errorCode: 'unavailable', message: 'raw' },
    { ok: true, peer: o.peer, record: { status: 'ready' } },
  ])
    assert.throws(() => codec.parseHostTaskCoordinationReply(bad))
})

it('hashes the full inventory independently of page order and never truncates the fifty-first item', () => {
  const items = vectors.observations[0].items
  assert.equal(codec.hostTaskCoordinationInventoryDigest(items), vectors.inventoryGoldens.twoItemsDigest)
  assert.equal(codec.hostTaskCoordinationInventoryDigest([]), vectors.inventoryGoldens.emptyDigest)
  assert.equal(codec.hostTaskCoordinationInventoryDigest(items), vectors.fenceAcks[0]!.inventoryDigest)
  assert.equal(
    codec.hostTaskCoordinationInventoryDigest(items),
    codec.hostTaskCoordinationInventoryDigest([...items].reverse()),
  )
  const full = Array.from({ length: 51 }, (_, i) => ({ ...items[1]!, itemId: 'full-' + String(i) }))
  assert.equal(codec.hostTaskCoordinationInventoryDigest(full), vectors.inventoryGoldens.full51Digest)
  assert.notEqual(
    codec.hostTaskCoordinationInventoryDigest(full),
    codec.hostTaskCoordinationInventoryDigest(full.slice(0, 50)),
  )
  assert.throws(() => codec.hostTaskCoordinationInventoryDigest([items[0], items[0]]))
  assert.throws(() => codec.hostTaskCoordinationInventoryDigest([{ ...items[0], body: 'forbidden' }]))
  const sparse = [items[0], items[1]]
  Reflect.deleteProperty(sparse, '0')
  assert.throws(() => codec.hostTaskCoordinationInventoryDigest(sparse))
  let reads = 0
  const getter = [items[0]]
  Object.defineProperty(getter, '0', {
    enumerable: true,
    get: () => {
      reads++
      return items[0]
    },
  })
  assert.throws(() => codec.hostTaskCoordinationInventoryDigest(getter))
  assert.equal(reads, 0)
  assert.throws(() =>
    codec.hostTaskCoordinationInventoryDigest(
      Array.from({ length: 10001 }, (_, n) => ({ ...items[1]!, itemId: 'large-' + String(n) })),
    ),
  )
})
