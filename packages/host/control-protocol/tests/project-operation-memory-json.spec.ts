import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { twinBindingFixture } from './twin-binding-fixture.ts'
import {
  parseHostProjectMemoryJson,
  parseHostRemoteSessionJson,
  parseHostCollaborationAnalysisCommand,
  createHostProjectOperationEvent,
  parseHostProjectMemoryRequest,
  hostProjectMemoryBatchDigest,
  hostProjectMemoryCommandDigest,
} from '../src/index.ts'
import type { HostProjectMemoryDirective, HostProjectMemoryStage } from '../src/index.ts'

it('admits the actual nested confirmation envelope and fifty bounded reference events without relaxing Session JSON', () => {
  const f = twinBindingFixture(),
    anchor = {
      action: 'project_operation_memory_anchor',
      input: { directive: f.directive, command: { operation: 'confirm', requestId: f.requestId, offer: f.offer } },
    }
  expect(parseHostProjectMemoryJson(anchor)).toEqual(anchor)
  expect(() => parseHostRemoteSessionJson(anchor)).toThrow()
  const data = JSON.parse(
    readFileSync(new URL('./fixtures/project-operation-memory-v3-owner-private.json', import.meta.url), 'utf8'),
  ) as {
    wire: { value: HostProjectMemoryDirective }[]
    commands: { body: HostProjectMemoryStage }[]
  }
  const original = data.commands[6]!.body,
    d = data.wire[0]!.value,
    events = Array.from({ length: 50 }, (_, i) =>
      createHostProjectOperationEvent({
        originSide: 'dsh',
        originActorRef: d.scope.sourceRef.actorRef,
        sourceEventId: 'event_' + String(i),
        sourceRevision: '1',
        sourceSequence: String(i + 1),
        projectId: d.scope.projectId,
        occurredAt: 150,
        kind: 'operation',
        taskRef: null,
        stepRef: null,
        invocationRef: null,
        evidenceRef: null,
        sourcePolicy: 'live_reference_v1',
        sourceLocator: {
          providerId: 'dsh-project-operation-v1',
          sourceEventId: 'event_' + String(i),
          sourceRevision: '1',
          sourceDigest: 'a'.repeat(64),
        },
        materialDependencies: [],
        content: null,
      }),
    ),
    candidate = { ...original, events },
    commandBody = {
      ...candidate,
      batchDigest: hostProjectMemoryBatchDigest(
        {
          direction: 'dsh_to_slark',
          scopeDigest: d.scope.scopeDigest,
          recipientDigest: original.expectedCheckpoint.recipientDigest,
        },
        candidate,
      ),
    },
    request = parseHostProjectMemoryRequest({
      directive: { ...d, operation: 'apply', commandDigest: hostProjectMemoryCommandDigest('apply', commandBody) },
      commandBody,
    })
  expect(parseHostCollaborationAnalysisCommand({ action: 'project_operation_memory', request })).toEqual({
    action: 'project_operation_memory',
    request,
  })
  expect(() => parseHostRemoteSessionJson(request)).toThrow()
})

it('rejects unsafe values and property access without executing getters', () => {
  const getter = vi.fn(() => 'forbidden'),
    object = Object.defineProperty({}, 'value', { enumerable: true, get: getter }),
    array = Object.defineProperty([], '0', { enumerable: true, get: getter })
  for (const value of [
    undefined,
    Symbol('x'),
    1n,
    () => {},
    NaN,
    Infinity,
    Object.create(null),
    object,
    array,
    new Array(2),
    Object.assign([], { extra: 1 }),
    Object.assign([], { [Symbol('extra')]: 1 }),
    { [Symbol('key')]: 1 },
    Object.defineProperty({}, 'hidden', { value: 1 }),
    JSON.parse('{"__proto__":{}}') as unknown,
    new Proxy({}, { ownKeys: () => ['phantom'], getOwnPropertyDescriptor: () => undefined }),
    { constructor: 1 },
    { prototype: 1 },
    { '': 1 },
    { ['x'.repeat(129)]: 1 },
    { '\u0001': 1 },
  ])
    expect(() => parseHostProjectMemoryJson(value)).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(parseHostProjectMemoryJson([null, true, false, 12, 'value', { value: [] }])).toEqual([
    null,
    true,
    false,
    12,
    'value',
    { value: [] },
  ])
})

it('bounds encoded bytes, depth, nodes, array length and object fanout independently', () => {
  const nested = (levels: number): unknown => (levels === 0 ? null : { value: nested(levels - 1) })
  expect(parseHostProjectMemoryJson(nested(12))).toEqual(nested(12))
  expect(() => parseHostProjectMemoryJson(nested(13))).toThrow()
  expect(() => parseHostProjectMemoryJson(Array.from({ length: 8192 }, () => null))).toThrow()
  expect(() => parseHostProjectMemoryJson(new Array(10001))).toThrow()
  expect(() =>
    parseHostProjectMemoryJson(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), null]))),
  ).toThrow()
  expect(() => parseHostProjectMemoryJson('x'.repeat(32769))).toThrow()
  expect(() => parseHostProjectMemoryJson(['x'.repeat(32768), 'y'.repeat(32768)])).toThrow()
})
