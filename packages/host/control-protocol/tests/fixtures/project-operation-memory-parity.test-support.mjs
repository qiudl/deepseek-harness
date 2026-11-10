/** Opt-in cross-check of literal owner-private vectors against a separately configured Slark checkout. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_MEMORY_PARITY_SLARK_ROOT
if (!root) throw Error('DSH_MEMORY_PARITY_SLARK_ROOT is required')
const load = name => import(pathToFileURL(resolve(root, 'packages/runtime/src/' + name + '.ts')).href)
const wire = await load('dsh-project-operation-memory')
const commands = await load('dsh-project-operation-memory-command')
const results = await load('dsh-project-operation-read-result')
const fixture = JSON.parse(readFileSync(new URL('./project-operation-memory-v3-owner-private.json', import.meta.url), 'utf8'))
const codecs = [
  [wire.parseProjectMemoryDirective, wire.encodeProjectMemoryDirective, wire.projectMemoryDirectiveDigest],
  [wire.parseProjectMemorySourceProof, wire.encodeProjectMemorySourceProof, wire.projectMemorySourceProofDigest],
  [wire.parseProjectMemoryProjectionProof, wire.encodeProjectMemoryProjectionProof, null],
  [wire.parseProjectMemoryHostAck, wire.encodeProjectMemoryHostAck, wire.projectMemoryHostAckDigest],
  [wire.parseProjectMemoryReceipt, wire.encodeProjectMemoryReceipt, wire.projectMemoryReceiptDigest],
]
for (const [i, vector] of fixture.wire.entries()) {
  const [parse, encode, digest] = codecs[i]
  assert.deepEqual(parse(vector.value), vector.value)
  assert.equal(encode(vector.value), vector.preimage)
  if (digest) assert.equal(digest(vector.value), vector.digest)
  assert.throws(() => parse({ ...vector.value, verified: true }))
}
for (const vector of fixture.commands) {
  assert.deepEqual(commands.parseProjectMemoryCommand(vector.operation, vector.body), vector.body)
  assert.equal(commands.projectMemoryCommandDigest(vector.operation, vector.body), vector.digest)
  assert.throws(() => commands.parseProjectMemoryCommand(vector.operation, { ...vector.body, verified: true }))
  const directive = { ...fixture.wire[0].value, operation: vector.operation, commandDigest: vector.digest }
  assert.deepEqual(commands.parseProjectMemoryRequest({ directive, commandBody: vector.body }), { directive, commandBody: vector.body })
}
assert.equal(commands.projectMemoryBatchDigest(fixture.batch.context, fixture.commands[6].body), fixture.batch.digest)
for (const vector of fixture.readResults) {
  assert.deepEqual(results.parseProjectMemoryReadResult(vector.operation, vector.value), vector.value)
  assert.equal(results.projectMemoryReadResultDigest(vector.operation, vector.value), vector.digest)
  assert.throws(() => results.parseProjectMemoryReadResult(vector.operation, { ...vector.value, verified: true }))
}
console.log('memory parity: 5 signed values, 9 command branches, 6 read results, extra fields rejected')
