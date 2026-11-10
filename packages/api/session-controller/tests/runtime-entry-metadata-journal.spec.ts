/** Main-directed signed-proof persistence only; controlled vectors are not a current Source permission. */
import { mkdtempSync, chmodSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { runtimeEntryReceiptDigest, parseRuntimeEntryBinding, parseRuntimeEntryObservation, parseRuntimeEntryAttribution, runtimeEntryObservationDigest, parseRuntimeEntryMetadataAuthorization, type RuntimeEntryObservation, type RuntimeEntryAttribution } from '@deepseek-ai/dsh-host-control-protocol'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import { RuntimeEntryJournal, readRuntimeEntryMetadataAuthorization, readRuntimeEntryWitness, readRuntimeEntryFrontier, readRuntimeEntryEffect, readRuntimeEntryPublicationPair } from '../src/runtime-entry-journal.ts'
const fixture = { value: parseRuntimeEntryMetadataAuthorization((JSON.parse(readFileSync(new URL(
  '../../../host/control-protocol/tests/fixtures/runtime-entry-metadata-authorization-v1.json', import.meta.url), 'utf8')) as {
  value: unknown }).value) }

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'req0006-native-proof-')); chmodSync(root, 0o700)
  const path = join(root, 'runtime-entry.sqlite'), journal = new RuntimeEntryJournal(path)
  onTestFinished(() => { journal.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, path, journal }
}
function snapshot(root: string) {
  return Object.fromEntries(readdirSync(root).sort().map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]))
}
it('persists exact original signed bytes once and reads them independently after close/restart without renewing grant time', () => {
  const h = harness(), original = h.journal.retainMetadataAuthorization(fixture.value, () => true)
  expect(readRuntimeEntryMetadataAuthorization(h.path, original.metadata.binding.consumerCommandId)).toEqual(original)
  expect(h.journal.retainMetadataAuthorization(fixture.value, () => true)).toEqual(original)
  expect(h.journal.count()).toBe(0)
  h.journal.close()
  const reopened = new RuntimeEntryJournal(h.path)
  try {
    expect(reopened.retainMetadataAuthorization(fixture.value, () => true)).toEqual(original)
    expect(readRuntimeEntryMetadataAuthorization(h.path, randomUUID())).toBeUndefined()
    expect(() => reopened.retainMetadataAuthorization({ ...original, requestId: randomUUID() }, () => true)).toThrow('metadata_conflict')
    expect(readRuntimeEntryMetadataAuthorization(h.path, original.metadata.binding.consumerCommandId)).toEqual(original)
  } finally { reopened.close() }
})
it.each([1, 2])('rolls back all proof/counter writes when the actual owned fence is lost at check %s', (at) => {
  const h = harness(); let checks = 0
  expect(() => h.journal.retainMetadataAuthorization(fixture.value, () => ++checks !== at)).toThrow('fence_lost')
  const db = new DatabaseSync(h.path, { readOnly: true })
  try {
    expect(db.prepare('SELECT * FROM runtime_entry_metadata_budget').get()).toMatchObject({ rows: 0, bytes: 0 })
    expect(db.prepare('SELECT count(*) AS count FROM runtime_entry_metadata_authorizations').get()?.count).toBe(0)
  } finally { db.close() }
})
it('retains old original-ID recovery before bounded new admission and rejects SQL replacement/deletion', () => {
  const h = harness(), original = h.journal.retainMetadataAuthorization(fixture.value, () => true), db = new DatabaseSync(h.path)
  try {
    expect(() => db.prepare('UPDATE runtime_entry_metadata_authorizations SET authorization_json=?').run('{}')).toThrow('immutable')
    expect(() =>{  db.exec('DELETE FROM runtime_entry_metadata_authorizations') }).toThrow('immutable')
    expect(() =>{  db.exec('DELETE FROM runtime_entry_metadata_budget') }).toThrow('immutable')
    db.exec('UPDATE runtime_entry_metadata_budget SET rows=262144,bytes=2147483648 WHERE singleton=1')
    expect(h.journal.canRetainMetadataAuthorization(original.metadata.binding.consumerCommandId)).toBe(true)
    expect(h.journal.canRetainMetadataAuthorization(randomUUID())).toBe(false)
    expect(h.journal.retainMetadataAuthorization(fixture.value, () => true)).toEqual(original)
  } finally { db.close() }
})
it('keeps a known legacy v1 file and complete directory unchanged while denying a new writer/proof qualification', () => {
  const h = harness(); h.journal.close()
  const db = new DatabaseSync(h.path)
  try {
    db.exec('DROP TRIGGER runtime_entry_publication_pairs_no_update; DROP TRIGGER runtime_entry_publication_pairs_no_delete; DROP TABLE runtime_entry_publication_pairs; DROP TRIGGER runtime_entry_metadata_no_update; DROP TRIGGER runtime_entry_metadata_no_delete; DROP TRIGGER runtime_entry_metadata_budget_no_delete; DROP TABLE runtime_entry_metadata_authorizations; DROP TABLE runtime_entry_metadata_budget; PRAGMA user_version=1')
  } finally { db.close() }
  const before = snapshot(h.root)
  expect(readRuntimeEntryMetadataAuthorization(h.path, randomUUID())).toBeUndefined()
  expect(readRuntimeEntryWitness(h.path, randomUUID())).toBeUndefined()
  expect(() => new RuntimeEntryJournal(h.path)).toThrow('wrong_purpose')
  expect(snapshot(h.root)).toEqual(before)
})
it('refuses unknown schema/version before any sidecar or file mutation', () => {
  const h = harness(); h.journal.close()
  const db = new DatabaseSync(h.path)
  try { db.exec('PRAGMA user_version=99') } finally { db.close() }
  const before = snapshot(h.root)
  expect(() => new RuntimeEntryJournal(h.path)).toThrow('wrong_purpose')
  expect(() => readRuntimeEntryMetadataAuthorization(h.path, randomUUID())).toThrow('wrong_purpose')
  expect(snapshot(h.root)).toEqual(before)
})

it('reads actual v2 zero and committed effect frontiers without deriving a source sequence or renewing authority', () => {
  const h = harness(), empty = readRuntimeEntryFrontier(h.path)
  expect(empty.journalEpoch).toBe('1'); expect(empty.effectHead).toBe('0')
  expect(empty.journalId).toMatch(/^[0-9a-f-]{36}$/u)
  const sha = '1'.repeat(64), binding = parseRuntimeEntryBinding({ ...fixture.value.metadata.binding,
    grantIssuedAt: Date.now() - 1000, grantExpiresAt: Date.now() + 60000 })
  const original = h.journal.commitOriginalInvocationEntry({ binding, implementationDigest: sha, compositionDigest: sha,
    queueOccurrenceId: randomUUID(), queueGeneration: '1', driverReservationId: randomUUID(), workerLifetimeId: randomUUID(),
    sessionInstanceGeneration: '1', sessionBirthReceiptDigest: sha,
    manifestInputs: { originalAuthorityDigest: sha, accountAuthorityDigest: sha, sessionAuthorityDigest: sha,
      compositionAuthorityDigest: sha, registryGeneration: '1' } }, () => true)
  const before = snapshot(h.root), frontier = readRuntimeEntryFrontier(h.path)
  expect(frontier).toEqual({ ...empty, effectHead: '1' })
  const expected = { entryId: original.receipt.entryId, entryReceiptDigest: runtimeEntryReceiptDigest(original.receipt),
    manifestDigest: original.receipt.manifestDigest }
  expect(readRuntimeEntryEffect(h.path, expected)).toEqual({ ...expected, journalId: empty.journalId,
    journalEpoch: '1', entryEffectSeq: '1' })
  expect(() => readRuntimeEntryEffect(h.path, { ...expected, entryReceiptDigest: '2'.repeat(64) })).toThrow('effect_mismatch')
  expect(readRuntimeEntryEffect(h.path, { ...expected, entryId: randomUUID() })).toBeUndefined()
  expect(snapshot(h.root)).toEqual(before)
})
it('does not initialize a preexisting truncated private journal or invent a missing frontier', () => {
  const h = harness(); h.journal.close(); writeFileSync(h.path, '', { mode: 0o600 })
  const before = snapshot(h.root)
  expect(() => new RuntimeEntryJournal(h.path)).toThrow('wrong_purpose')
  expect(() => readRuntimeEntryFrontier(h.path)).toThrow('wrong_purpose')
  expect(() => readRuntimeEntryFrontier(join(h.root, 'missing.sqlite'))).toThrow('missing')
  expect(snapshot(h.root)).toEqual(before)
})

it('recognizes an incomplete earlier draft v2 without silently altering tables or creating files', () => {
  const h = harness(); h.journal.close()
  const db = new DatabaseSync(h.path)
  try { db.exec('DROP TRIGGER runtime_entry_publication_pairs_no_update; DROP TRIGGER runtime_entry_publication_pairs_no_delete; DROP TABLE runtime_entry_publication_pairs') }
  finally { db.close() }
  const before = snapshot(h.root)
  expect(() => new RuntimeEntryJournal(h.path)).toThrow('catalog_changed')
  expect(() => readRuntimeEntryFrontier(h.path)).toThrow('catalog_changed')
  expect(snapshot(h.root)).toEqual(before)
})

it('reserves the original pair before entry, preserves exact bytes through quota saturation/restart, and rejects replacements and lost fences', () => {
  const h = harness(), now = Date.now(), sha = '1'.repeat(64)
  const g = { ...fixture.value.metadata.consumerGrantMetadata, grantIssuedAt: now - 1000, grantExpiresAt: now + 60000 }
  const keys = ['namespaceId', 'consumerCommandId', 'commandDigest', 'consumerAttemptId', 'consumerStepGrantId',
    'rootTaskId', 'rootTraceId', 'executionCommandId', 'terminalDeliveryId', 'terminalResultDigest', 'messageId', 'sessionId',
    'expectedEventCount', 'expectedLogDigest', 'hostEpoch', 'grantIssuedAt', 'grantExpiresAt'] as const
  g.consumerGrantDigest = createHash('sha256').update('slark.project-operation-runtime-entry-consumer-grant/v1\0' + JSON.stringify(keys.map(k => g[k]))).digest('hex')
  const binding = parseRuntimeEntryBinding({ ...fixture.value.metadata.binding, grantIssuedAt: g.grantIssuedAt,
    grantExpiresAt: g.grantExpiresAt, consumerGrantDigest: g.consumerGrantDigest })
  h.journal.retainMetadataAuthorization({ ...fixture.value, issuedAt: now, expiresAt: now + 60000,
    metadata: { ...fixture.value.metadata, binding, consumerGrantMetadata: g } }, () => true)
  const original = h.journal.commitOriginalInvocationEntry({ binding, implementationDigest: sha, compositionDigest: sha,
    queueOccurrenceId: randomUUID(), queueGeneration: '1', driverReservationId: randomUUID(), workerLifetimeId: randomUUID(),
    sessionInstanceGeneration: '1', sessionBirthReceiptDigest: sha, manifestInputs: { originalAuthorityDigest: sha,
      accountAuthorityDigest: sha, sessionAuthorityDigest: sha, compositionAuthorityDigest: sha, registryGeneration: '1' } }, () => true)
  const vector = JSON.parse(readFileSync(new URL('../../../host/control-protocol/tests/fixtures/project-operation-runtime-entry-v1.json', import.meta.url), 'utf8')) as { values: { observation: RuntimeEntryObservation; attribution: RuntimeEntryAttribution } }
  const observedAt = Date.now(), observation = parseRuntimeEntryObservation({ ...vector.values.observation,
    receipt: original.receipt, readbackDigest: original.readbackDigest, issuedAt: observedAt, expiresAt: observedAt + 15000,
    sourceEventMapping: { ...vector.values.observation.sourceEventMapping, entryId: original.receipt.entryId,
      sourceEventId: 'dsh-runtime-entry:' + original.receipt.entryId,
      entryReceiptDigest: runtimeEntryReceiptDigest(original.receipt), manifestDigest: original.receipt.manifestDigest } })
  const mapping = observation.sourceEventMapping
  if (!mapping) throw Error('missing fixture mapping')
  const attribution = parseRuntimeEntryAttribution({ ...vector.values.attribution, binding, entryId: original.receipt.entryId,
    entryReceiptDigest: runtimeEntryReceiptDigest(original.receipt), manifestDigest: original.receipt.manifestDigest,
    issuedAt: observedAt, expiresAt: observedAt + 120000, observationDigest: runtimeEntryObservationDigest(observation),
    sourceEventId: mapping.sourceEventId, sourceRevision: mapping.sourceRevision,
    payloadDigest: mapping.payloadDigest })
  const pair = { observation, attribution }, sql = new DatabaseSync(h.path)
  try {
    expect(() => h.journal.retainPublicationPair(original.receipt.entryId, pair, () => false)).toThrow('fence_lost')
    expect(readRuntimeEntryPublicationPair(h.path, original.receipt.entryId)).toBeUndefined()
    sql.exec('UPDATE runtime_entry_metadata_budget SET rows=262144,bytes=2147483648 WHERE singleton=1')
    expect(h.journal.retainPublicationPair(original.receipt.entryId, pair, () => true)).toEqual(pair)
    expect(sql.prepare('SELECT bytes FROM runtime_entry_metadata_budget').get()?.bytes).toBeLessThan(2147483648)
    const retained = readRuntimeEntryPublicationPair(h.path, original.receipt.entryId)
    expect(retained).toEqual(pair)
    expect(h.journal.retainPublicationPair(original.receipt.entryId, pair, () => true)).toEqual(retained)
    expect(() => h.journal.retainPublicationPair(original.receipt.entryId, { ...pair, attribution: { ...attribution,
      requestId: randomUUID() } }, () => true)).toThrow('publication_conflict')
    expect(() =>{  sql.exec('DELETE FROM runtime_entry_publication_pairs') }).toThrow('immutable')
    expect(() =>{  sql.exec("UPDATE runtime_entry_publication_pairs SET pair_json='{}'" ) }).toThrow('immutable')
    expect(h.journal.read(original.receipt.entryId)).toEqual(original)
  } finally { sql.close() }
  h.journal.close()
  expect(readRuntimeEntryPublicationPair(h.path, original.receipt.entryId)).toEqual(pair)
  const reopened = new RuntimeEntryJournal(h.path)
  try { expect(reopened.retainPublicationPair(original.receipt.entryId, pair, () => true)).toEqual(pair) } finally { reopened.close() }
})
