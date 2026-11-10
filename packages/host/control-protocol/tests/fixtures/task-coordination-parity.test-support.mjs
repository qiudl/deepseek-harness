/** Explicit paired-codec check; no carrier, runtime authority or network effects. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const root = process.env.DSH_TASK_COORDINATION_PARITY_SLARK_ROOT
assert(root, 'explicit isolated Slark root required')
const results = await Promise.allSettled([import(new URL('../../src/task-coordination.ts', import.meta.url).href),
  import(pathToFileURL(resolve(root, 'packages/runtime/src/dsh-task-coordination.ts')).href)])
for (const [i, result] of results.entries()) if (result.status === 'rejected') console.error((i === 0 ? 'Host' : 'Source') + ': ' + result.reason.message)
assert(results.every(result => result.status === 'fulfilled'), 'both actual codecs must be present')
const [host, source] = results.map(result => result.value)
const names = ['parseHostTaskCoordinationScope', 'parseHostTaskCoordinationInput', 'parseHostTaskCoordinationReply',
  'parseHostTaskCoordinationDirective', 'parseHostTaskCoordinationFenceAck', 'parseHostTaskCoordinationObservation',
  'encodeHostTaskCoordinationDirective', 'encodeHostTaskCoordinationFenceAck', 'encodeHostTaskCoordinationObservation',
  'hostTaskCoordinationScopeDigest', 'hostTaskCoordinationFloorDigest', 'hostTaskCoordinationCommandDigest',
  'hostTaskCoordinationDirectiveDigest', 'hostTaskCoordinationInventoryDigest']
for (const name of names) assert.equal(typeof host[name], 'function', name)
for (const name of names) assert.equal(typeof source[name], 'function', name)
assert.equal(host.HOST_TASK_COORDINATION_AUDIENCE, 'urn:slark:task-coordination:v1')
assert.equal(source.HOST_TASK_COORDINATION_AUDIENCE, host.HOST_TASK_COORDINATION_AUDIENCE)
const hostEnvironment = await import(new URL('../../src/task-coordination-environment.ts', import.meta.url).href)
const sourceEnvironment = await import(pathToFileURL(resolve(root, 'packages/runtime/src/dsh-task-coordination-environment.ts')).href)
const { readFile } = await import('node:fs/promises')
const vectors = JSON.parse(await readFile(new URL('./task-coordination-v1.json', import.meta.url), 'utf8'))
assert.deepEqual(hostEnvironment.parseHostTaskCoordinationEnvironments(JSON.stringify(vectors.environments)), sourceEnvironment.parseHostTaskCoordinationEnvironments(JSON.stringify(vectors.environments)))
for (const value of vectors.environments) assert.deepEqual(hostEnvironment.parseHostTaskCoordinationEnvironment(value), sourceEnvironment.parseHostTaskCoordinationEnvironment(value))
for (const vector of vectors.inputs) {
  assert.deepEqual(host.parseHostTaskCoordinationInput(vector), source.parseHostTaskCoordinationInput(vector))
  assert.equal(host.encodeHostTaskCoordinationDirective(vector.directive), source.encodeHostTaskCoordinationDirective(vector.directive))
  for (const suffix of ['Scope', 'Floor']) assert.equal(host['hostTaskCoordination' + suffix + 'Digest'](vector.directive.scope),
    source['hostTaskCoordination' + suffix + 'Digest'](vector.directive.scope))
  assert.equal(host.hostTaskCoordinationCommandDigest(vector.command), source.hostTaskCoordinationCommandDigest(vector.command))
  assert.equal(host.hostTaskCoordinationDirectiveDigest(vector.directive), source.hostTaskCoordinationDirectiveDigest(vector.directive))
}
for (const [kind, parse, encode] of [['fenceAcks', 'parseHostTaskCoordinationFenceAck', 'encodeHostTaskCoordinationFenceAck'],
  ['observations', 'parseHostTaskCoordinationObservation', 'encodeHostTaskCoordinationObservation']])
  for (const vector of vectors[kind]) {
    assert.deepEqual(host[parse](vector), source[parse](vector))
    assert.equal(host[encode](vector), source[encode](vector))
  }
assert.equal(host.hostTaskCoordinationInventoryDigest(vectors.observations[0].items), source.hostTaskCoordinationInventoryDigest(vectors.observations[0].items))
for (const vector of vectors.replies) assert.deepEqual(host.parseHostTaskCoordinationReply(vector), source.parseHostTaskCoordinationReply(vector))
console.log('task coordination parity: scopes, four commands, signed directive/Ack/observation and replies')
