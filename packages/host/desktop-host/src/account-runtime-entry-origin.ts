/** Main-owned installation signing after independent original-entry and DSBot mapping reads. */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { readRuntimeEntryWitness, readRuntimeEntryPublicationPair } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-journal'
import type { RuntimeEntryOriginalMetadata } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry'
import type { ProjectOperationRuntimeEntryCandidate, ProjectOperationRuntimeEntryPublication } from '@deepseek-ai/dsh-api-session-controller'
import { parseRuntimeEntrySourceEventMapping, parseRuntimeEntryObservation, parseRuntimeEntryAttribution,
  runtimeEntryReceiptDigest, runtimeEntryBindingDigest, runtimeEntryObservationDigest, runtimeEntryAttributionDigest,
  runtimeEntrySourceEventMappingDigest, encodeRuntimeEntryObservation,
  encodeRuntimeEntryAttribution } from '@deepseek-ai/dsh-host-control-protocol'
import type { RuntimeEntryObservation, RuntimeEntrySourceEventMapping, HostBotGroupPublicKeyring } from '@deepseek-ai/dsh-host-control-protocol'

function unavailable(): never { throw Error('runtime_entry_publication_unavailable') }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim()
const sourceTables = `CREATE TABLE journal_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=2),
journal_epoch TEXT NOT NULL,last_sequence INTEGER NOT NULL CHECK(last_sequence>=0));
CREATE TABLE operation_records(sequence INTEGER PRIMARY KEY CHECK(sequence>0),
profile_id TEXT NOT NULL,bot_root_id TEXT NOT NULL,session_id TEXT NOT NULL,event_seq INTEGER NOT NULL CHECK(event_seq>=0),
event_time INTEGER NOT NULL,record_state TEXT NOT NULL CHECK(record_state IN('gap','reference','fact')),
initiator_ref TEXT,project_id TEXT,gap_reason TEXT,source_event_id TEXT NOT NULL UNIQUE,
record_hash TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)),
UNIQUE(profile_id,bot_root_id,session_id,event_seq));
CREATE TABLE operation_revisions(sequence INTEGER PRIMARY KEY CHECK(sequence>0),
source_event_id TEXT NOT NULL REFERENCES operation_records(source_event_id),
source_revision INTEGER NOT NULL CHECK(source_revision>1),
record_hash TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)),
record_state TEXT NOT NULL CHECK(record_state IN('gap','reference','fact')),
initiator_ref TEXT,project_id TEXT,gap_reason TEXT,
UNIQUE(source_event_id,source_revision));
CREATE TABLE session_checkpoints(profile_id TEXT NOT NULL,bot_root_id TEXT NOT NULL,session_id TEXT NOT NULL,
event_count INTEGER NOT NULL CHECK(event_count>=0),prefix_digest TEXT NOT NULL,
PRIMARY KEY(profile_id,bot_root_id,session_id));
CREATE TABLE runtime_entry_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1));
CREATE TABLE runtime_entry_candidates(entry_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0),
profile_id TEXT NOT NULL,bot_root_id TEXT NOT NULL,session_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,project_id TEXT NOT NULL,
entry_effect_at INTEGER NOT NULL,candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
event_json TEXT NOT NULL CHECK(json_valid(event_json)),mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)));
CREATE TABLE runtime_entry_publications(entry_id TEXT PRIMARY KEY REFERENCES runtime_entry_candidates(entry_id),
publication_json TEXT NOT NULL CHECK(json_valid(publication_json)));`.split(';').filter(v => v.trim()).map(normalized)
const sourceIndex = 'CREATE INDEX operation_scope ON operation_records(profile_id,bot_root_id,initiator_ref,project_id,sequence)'

/** Actual account/installation/worker lease captured by Main before any asynchronous operation. */
export interface RuntimeEntryMainLease {
  readonly account: Readonly<{ authorityEnvironmentId: string
    accountIssuer: string
    accountSubject: string
    accountBindingId: string
    accountBindingVersion: number
    hostProfileId: string }>
  readonly peer: Readonly<{ computerId: string
    installationId: string
    hostRegistryId: string
    hostEpoch: string
    publicKey: string
    hostInstanceId: string
    processNonce: string }>
  readonly issuer: string
  readonly keyId: string
  /** Throw after Account, Profile, actual worker, installation, Agent or composition replacement. */
  assertCurrent(): void
}
/** Bootstrap-private fixed paths and real authenticated Cloud routes; never constructed from a plugin request. */
export interface AccountRuntimeEntryOriginOptions {
  readonly profileRoot: string
  readonly pluginHome: string
  readonly entryJournalPath: string
  readonly implementationDigest: string
  readonly compositionDigest: string
  /** Actual verified artifact closure, including the DSBot journal and native-entry implementation. */
  readonly artifactPins: readonly Readonly<{ path: string
    sha256: string }>[]
  readonly keyrings: readonly HostBotGroupPublicKeyring[]
  /** @returns The actual Account/Profile/worker lease for this private route. */
  captureCurrentLease(): RuntimeEntryMainLease
  /** @param commandId - Original command, resolved through the actual original-chain metadata path.
   * @param signal - Original request cancellation.
   * @returns Current original chain metadata; absence means unsupported.
   */
  readOriginalMetadata(commandId: string, signal: AbortSignal): Promise<RuntimeEntryOriginalMetadata | undefined>
  /** @param bytes - Fixed observation signature preimage.
   * @returns Actual installation Ed25519 signature. */
  sign(bytes: Uint8Array): string
  /** @param observation - Main's installation-signed independent read.
   * @param signal - Current authenticated Account cancellation.
   * @returns Stored original signed observation/attribution pair after the actual current Cloud authorization check.
   */
  registerObservation(observation: RuntimeEntryObservation, signal: AbortSignal): Promise<unknown>
}
interface Coordinates {
  readonly originalCommandId: string
  readonly entryId: string
  readonly sourceEventId: string
  readonly sourceRevision: string
}
function file(path: string, directory = false) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    process.getuid !== undefined && stat.uid !== process.getuid() || process.platform !== 'win32' && (stat.mode & 0o077) !== 0 ||
    !directory && stat.nlink !== 1) return unavailable()
  return stat
}
function ownedPath(root: string, path: string, directory = false) {
  if (realpathSync(root) !== root || realpathSync(path) !== path) return unavailable()
  const suffix = relative(root, path)
  if (suffix.startsWith('..' + sep) || suffix === '..' || resolve(path) !== path) return unavailable()
  file(root, true)
  const parts = suffix.split(sep)
  let current = root
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    current = join(current, part); file(current, i < parts.length - 1 || directory)
  }
  return file(path, directory)
}
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024, MAX_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024
function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs &&
    a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink
}
function descriptorDigest(fd: number, size: number) {
  const digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
  for (let offset = 0; offset < size;) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset)
    if (count === 0) unavailable()
    digest.update(chunk.subarray(0, count)); offset += count
  }
  return digest.digest('hex')
}
/** SQLite opens only the private copy. Original WAL/SHM descriptors stay read-only through both content fences. */
function sourceSnapshot(root: string, home: string) {
  const sourceDirectory = ownedPath(root, home, true)
  const sources: { path: string
    suffix: string
    fd: number
    stat: Stats
    digest: string }[] = []
  let directory: string | undefined
  const cleanup = () => {
    try { for (const source of sources) closeSync(source.fd) }
    finally { if (directory !== undefined) rmSync(directory, { recursive: true, force: true }) }
  }
  try {
    let total = 0
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(home, 'project-operations.sqlite' + suffix), stat = ownedPath(root, path)
      if (stat.size === 0 || stat.size > MAX_SOURCE_FILE_BYTES || !Number.isSafeInteger(stat.size)) unavailable()
      total += stat.size
      if (total > MAX_SOURCE_TOTAL_BYTES) unavailable()
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      sources.push({ path, suffix, fd, stat, digest: '' })
      if (!sameFile(stat, fstatSync(fd))) unavailable()
    }
    const main = sources[0]
    if (main === undefined) unavailable()
    const header = Buffer.alloc(100)
    if (readSync(main.fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
      header[18] !== 2 || header[19] !== 2 || header.readUInt32BE(68) !== 0 || header.readUInt32BE(60) !== 0) unavailable()
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-runtime-entry-read-')))
    file(directory, true)
    const path = join(directory, 'project-operations.sqlite')
    for (const source of sources) {
      const bytes = Buffer.alloc(source.stat.size)
      for (let offset = 0; offset < bytes.length;) {
        const count = readSync(source.fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
        if (count === 0) unavailable()
        offset += count
      }
      source.digest = hash(bytes)
      writeFileSync(path + source.suffix, bytes, { flag: 'wx', mode: 0o600 })
    }
    const assertCurrent = () => {
      if (!sameFile(sourceDirectory, ownedPath(root, home, true))) unavailable()
      for (const source of sources) {
        if (!sameFile(source.stat, ownedPath(root, source.path)) || !sameFile(source.stat, fstatSync(source.fd)) ||
          descriptorDigest(source.fd, source.stat.size) !== source.digest || !sameFile(source.stat, fstatSync(source.fd)) ||
          !sameFile(source.stat, ownedPath(root, source.path))) unavailable()
      }
    }
    assertCurrent()
    const generation = hash(JSON.stringify(sources.map(source => [source.stat.dev, source.stat.ino, source.stat.size,
      source.stat.mtimeMs, source.stat.ctimeMs, source.digest])))
    return { path, generation, assertCurrent, cleanup }
  } catch (error) { cleanup(); throw error }
}
function event(candidate: ProjectOperationRuntimeEntryCandidate, sequence: string) {
  const c = candidate, sourceEventId = 'dsh-runtime-entry:' + c.entryId
  const content = { goalSummary: 'Handle original invocation feedback.',
    operationSummary: 'Start handling feedback in the DSH Bot runtime.',
    outcome: 'succeeded', resultSummary: 'Runtime entry for the original invocation feedback was durably recorded.',
    failureCode: null, unfinishedRefs: [], verification: 'observed_receipt' }
  const values = ['dsh', 'deepseek-bot:' + c.botRootId, sourceEventId, '1', sequence, c.projectId, c.entryEffectAt, 'operation',
    c.taskRef, null, c.invocationRef, 'runtime-entry:' + c.entryId, 'owner_native_operation_fact_v1', null, [], Object.values(content)]
  return { originSide: 'dsh', originActorRef: 'deepseek-bot:' + c.botRootId, sourceEventId, sourceRevision: '1', sourceSequence: sequence,
    projectId: c.projectId, occurredAt: c.entryEffectAt, kind: 'operation',
    payloadDigest: hash('slark.project-operation-memory.event/v1\0' + JSON.stringify(values)),
    taskRef: c.taskRef, stepRef: null, invocationRef: c.invocationRef, evidenceRef: 'runtime-entry:' + c.entryId,
    sourcePolicy: 'owner_native_operation_fact_v1', sourceLocator: null, materialDependencies: [], content }
}
/** Check the embedding's actual files before startup advertises this optional capability.
 * @param artifactPins - Strict trusted startup closure; no operation supplies these paths.
 * @returns Nothing; changed, aliased, oversized or mismatched artifacts reject.
 */
export function assertRuntimeEntryOriginArtifacts(artifactPins: AccountRuntimeEntryOriginOptions['artifactPins']): void {
  if (artifactPins.length < 2 || !artifactPins.some(p => p.path.endsWith('/project-operation-native-entry.js')) ||
    !artifactPins.some(p => p.path.endsWith('/project-operation-journal.js'))) unavailable()
  let total = 0
  for (const pin of artifactPins) {
    const before = lstatSync(pin.path)
    if (!before.isFile() || before.isSymbolicLink() || realpathSync(pin.path) !== pin.path || before.size > 64 * 1024 * 1024) unavailable()
    total += before.size
    if (total > 128 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(pin.sha256) || hash(readFileSync(pin.path)) !== pin.sha256) unavailable()
    if (!sameFile(before, lstatSync(pin.path))) unavailable()
  }
}

/** Independent Main reader/signer; neither receipt DTOs nor caller paths are accepted. */
export class AccountRuntimeEntryOrigin {
  /** @param options - Actual bootstrap pins, fixed Profile storage and authenticated original-chain routes. */
  constructor(private readonly options: AccountRuntimeEntryOriginOptions) {
    this.artifacts()
  }
  private artifacts() { assertRuntimeEntryOriginArtifacts(this.options.artifactPins) }
  private mapping(candidate: ProjectOperationRuntimeEntryCandidate, requirePublication: boolean) {
    const o = this.options
    const snapshot = sourceSnapshot(o.profileRoot, o.pluginHome)
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(snapshot.path)
      // SQLite validates and applies committed WAL only inside the disposable copy; a discarded WAL cannot qualify stale main data.
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      if (checkpoint?.busy !== 0 || typeof checkpoint.log !== 'number' || checkpoint.log <= 0 ||
        checkpoint.checkpointed !== checkpoint.log) unavailable()
      db.exec('PRAGMA query_only=ON; BEGIN')
      if (db.prepare('PRAGMA application_id').get()?.application_id !== 0 ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 0) unavailable()
      const catalog = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
      if (catalog.length !== sourceTables.length + 1 || catalog.some(row => typeof row.sql !== 'string' ||
        (row.type === 'table' ? !sourceTables.includes(normalized(row.sql)) : row.type !== 'index' ||
          row.sql !== sourceIndex))) unavailable()
      const meta = db.prepare('SELECT schema_version,journal_epoch,CAST(last_sequence AS TEXT) AS head FROM journal_meta WHERE id=1').get()
      const native = db.prepare('SELECT id,schema_version FROM runtime_entry_meta').all()
      if (db.prepare('SELECT id FROM journal_meta').all().length !== 1 || meta?.schema_version !== 2 ||
        native.length !== 1 || native[0]?.id !== 1 || native[0].schema_version !== 1 || typeof meta.journal_epoch !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(meta.journal_epoch) ||
          typeof meta.head !== 'string') unavailable()
      const row = db.prepare(`SELECT entry_id,CAST(sequence AS TEXT) AS sequence,profile_id,bot_root_id,session_id,owner_user_id,project_id,
        entry_effect_at,candidate_json,event_json,mapping_json FROM runtime_entry_candidates WHERE entry_id=?`).get(candidate.entryId)
      if (!row || typeof row.sequence !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(row.sequence) ||
        BigInt(row.sequence) > BigInt(meta.head) ||
        row.profile_id !== candidate.profileId || row.bot_root_id !== candidate.botRootId || row.session_id !== candidate.sessionId ||
        row.owner_user_id !== candidate.ownerUserId || row.project_id !== candidate.projectId ||
          row.entry_effect_at !== candidate.entryEffectAt ||
        row.entry_id !== candidate.entryId || typeof row.candidate_json !== 'string' ||
          typeof row.event_json !== 'string' || typeof row.mapping_json !== 'string' ||
        !isDeepStrictEqual(JSON.parse(row.candidate_json), candidate)) unavailable()
      const expectedEvent = event(candidate, row.sequence)
      const mapping = parseRuntimeEntrySourceEventMapping(JSON.parse(row.mapping_json))
      const expectedMapping = { journalId: 'dsh-project-operation:' + meta.journal_epoch, journalEpoch: meta.journal_epoch,
        providerId: 'dsh-project-operation-v1', providerVersion: '1', sourceEventId: expectedEvent.sourceEventId, sourceRevision: '1',
        sourceSequence: row.sequence, payloadDigest: expectedEvent.payloadDigest, entryId: candidate.entryId,
        entryReceiptDigest: candidate.entryReceiptDigest, manifestDigest: candidate.manifestDigest }
      if (!isDeepStrictEqual(JSON.parse(row.event_json), expectedEvent) || !isDeepStrictEqual(mapping, expectedMapping)) unavailable()
      const published = db.prepare('SELECT publication_json FROM runtime_entry_publications WHERE entry_id=?').get(candidate.entryId)
      if (requirePublication && published === undefined) unavailable()
      db.exec('COMMIT')
      db.close(); db = undefined
      snapshot.assertCurrent()
      const publication: unknown = published === undefined ? null : JSON.parse(String(published.publication_json))
      return { mapping, publication,
        generation: snapshot.generation }
    } finally {
      try { db?.close() }
      finally { snapshot.cleanup() }
    }
  }
  private async capture(commandId: string, entryId: string, signal: AbortSignal) {
    const o = this.options, lease = o.captureCurrentLease()
    const current = () => { signal.throwIfAborted(); lease.assertCurrent(); this.artifacts() }
    current()
    const original = await o.readOriginalMetadata(commandId, signal)
    current()
    if (original === undefined || !original.isCurrent() || original.binding.consumerCommandId !== commandId) unavailable()
    ownedPath(o.profileRoot, o.entryJournalPath)
    const witness = readRuntimeEntryWitness(o.entryJournalPath, entryId)
    if (witness === undefined || witness.receipt.entryId !== entryId ||
      witness.receipt.implementationDigest !== o.implementationDigest || witness.receipt.compositionDigest !== o.compositionDigest ||
      witness.inputs.originalAuthorityDigest !== original.originalAuthorityDigest ||
        witness.inputs.accountAuthorityDigest !== original.accountAuthorityDigest ||
      runtimeEntryBindingDigest(witness.receipt.binding) !== runtimeEntryBindingDigest(original.binding)) unavailable()
    const b = witness.receipt.binding, a = lease.account
    if (a.authorityEnvironmentId !== b.authorityEnvironmentId || a.hostProfileId !== b.hostProfileId) unavailable()
    const candidate: ProjectOperationRuntimeEntryCandidate = Object.freeze({ profileId: brandString<ProjectOperationRuntimeEntryCandidate['profileId']>(b.hostProfileId),
      botRootId: brandString<ProjectOperationRuntimeEntryCandidate['botRootId']>(b.botId),
      sessionId: brandString<ProjectOperationRuntimeEntryCandidate['sessionId']>(b.sessionId), ownerUserId: brandString<ProjectOperationRuntimeEntryCandidate['ownerUserId']>(b.ownerUserId), projectId: original.projectId,
      taskRef: original.taskRef,
      invocationRef: brandString<ProjectOperationRuntimeEntryCandidate['invocationRef']>(b.invocationId), entryId: brandString<ProjectOperationRuntimeEntryCandidate['entryId']>(entryId), entryEffectAt: witness.receipt.entryEffectAt,
      entryReceiptDigest: runtimeEntryReceiptDigest(witness.receipt), manifestDigest: witness.receipt.manifestDigest })
    return { lease, witness, candidate, current: () => { current(); if (!original.isCurrent()) unavailable() } }
  }
  /** Read historical entry through the actual current private Profile route, without waking its driver.
   * @param entryId - Original entry identity.
   * @param signal - Current authenticated request cancellation.
   * @returns Fresh installation observation of a verified published source mapping.
   */
  async observe(entryId: string, signal: AbortSignal): Promise<RuntimeEntryObservation> {
    signal.throwIfAborted()
    const lease = this.options.captureCurrentLease()
    lease.assertCurrent(); this.artifacts()
    ownedPath(this.options.profileRoot, this.options.entryJournalPath)
    const original = readRuntimeEntryWitness(this.options.entryJournalPath, entryId)
    if (original === undefined) unavailable()
    lease.assertCurrent()
    const captured = await this.capture(original.receipt.binding.consumerCommandId, entryId, signal)
    lease.assertCurrent()
    const { mapping, publication } = this.mapping(captured.candidate, true)
    const expectedKeys = ['attributionDigest', 'observationDigest', 'mappingDigest', 'entryId', 'entryReceiptDigest',
      'manifestDigest', 'projectId', 'sourceEventId', 'sourceRevision', 'payloadDigest']
    if (!publication || typeof publication !== 'object' || Object.getPrototypeOf(publication) !== Object.prototype ||
      Reflect.ownKeys(publication).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(publication, key)) ||
      ['attributionDigest', 'observationDigest'].some((key) => {
        const value: unknown = Reflect.get(publication, key)
        return typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)
      }) || Reflect.get(publication, 'mappingDigest') !== runtimeEntrySourceEventMappingDigest(mapping) ||
      Reflect.get(publication, 'entryId') !== captured.candidate.entryId ||
      Reflect.get(publication, 'projectId') !== captured.candidate.projectId ||
      Reflect.get(publication, 'sourceEventId') !== mapping.sourceEventId ||
      Reflect.get(publication, 'sourceRevision') !== mapping.sourceRevision ||
      Reflect.get(publication, 'entryReceiptDigest') !== captured.candidate.entryReceiptDigest ||
      Reflect.get(publication, 'manifestDigest') !== captured.candidate.manifestDigest ||
      Reflect.get(publication, 'payloadDigest') !== mapping.payloadDigest) unavailable()
    captured.current()
    return this.observation(captured, mapping)
  }
  /** Verify original retained Host/Cloud signatures and the actual immutable DSBot publication before a fresh Source observation.
   * @param entryId - Existing entry selected under the current signed memory directive.
   * @param signal - Actual current Account/worker request cancellation.
   * @returns Fresh independent observation and exact original signed pair; neither renews the historical grant.
   */
  async observePublished(entryId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const witness = readRuntimeEntryWitness(this.options.entryJournalPath, entryId),
      originalPair = readRuntimeEntryPublicationPair(this.options.entryJournalPath, entryId)
    if (!witness || !originalPair) unavailable()
    const captured = await this.capture(witness.receipt.binding.consumerCommandId, entryId, signal)
    const first = this.mapping(captured.candidate, true)
    const publication = this.acceptPair(captured, first, originalPair)
    captured.current()
    if (!isDeepStrictEqual(first.publication, publication)) unavailable()
    const observation = this.observation(captured, first.mapping)
    captured.current()
    return Object.freeze({ observation, originalPair, assertCurrent: captured.current })
  }

  /** Observe an independently read durable candidate before publication; the published-only observer stays separate.
   * @param entryId - Original entry resolved by the actual private worker consumer index.
   * @param signal - Current authenticated Account/Profile/worker request.
   * @returns Fresh installation observation containing the complete independently read original mapping.
   */
  async observeCandidate(entryId: string, signal: AbortSignal): Promise<RuntimeEntryObservation> {
    signal.throwIfAborted()
    const lease = this.options.captureCurrentLease()
    lease.assertCurrent(); this.artifacts()
    ownedPath(this.options.profileRoot, this.options.entryJournalPath)
    const original = readRuntimeEntryWitness(this.options.entryJournalPath, entryId)
    if (!original) unavailable()
    const captured = await this.capture(original.receipt.binding.consumerCommandId, entryId, signal)
    lease.assertCurrent()
    const first = this.mapping(captured.candidate, false)
    captured.current()
    return this.observation(captured, first.mapping)
  }

  /** Validate the real Cloud stored pair without requesting another grant or signing another observation.
   * @param entryId - Independently selected original entry.
   * @param returned - Exact original Cloud observation/attribution bytes returned to Desktop.
   * @param signal - Current authenticated metadata-only publication request.
   * @returns Historical semantic projection; every later export still requires fresh Source authority.
   */
  async bindPair(entryId: string, returned: unknown, signal: AbortSignal): Promise<ProjectOperationRuntimeEntryPublication> {
    const original = readRuntimeEntryWitness(this.options.entryJournalPath, entryId)
    if (!original) unavailable()
    const captured = await this.capture(original.receipt.binding.consumerCommandId, entryId, signal)
    const first = this.mapping(captured.candidate, false)
    return this.acceptPair(captured, first, returned)
  }

  private observation(captured: Awaited<ReturnType<AccountRuntimeEntryOrigin['capture']>>, mapping: RuntimeEntrySourceEventMapping) {
    const { lease, witness } = captured, now = Date.now()
    captured.current()
    const unsigned = parseRuntimeEntryObservation({ schemaVersion: 1, purpose: 'project_operation_runtime_entry_observation',
      issuer: lease.issuer, keyId: lease.keyId, ...lease.account, botId: witness.receipt.binding.botId, peer: lease.peer,
      requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'), issuedAt: now, expiresAt: now + 15000,
      receipt: witness.receipt, sourceEventMapping: mapping, readbackDigest: witness.readbackDigest, signature: 'A'.repeat(86) })
    const signed = parseRuntimeEntryObservation({ ...unsigned,
      signature: this.options.sign(Buffer.from(encodeRuntimeEntryObservation(unsigned))) })
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(lease.peer.publicKey, 'base64url')]), format: 'der', type: 'spki' })
    if (!verify(null, Buffer.from(encodeRuntimeEntryObservation(signed)), key, Buffer.from(signed.signature, 'base64url'))) unavailable()
    captured.current()
    return signed
  }
  /** Bind only the independently read original mapping through the actual Cloud original-chain writer.
   * @param request - Original command/entry and source identity/revision only.
   * @param signal - Current authenticated Account/Profile/worker cancellation.
   * @returns Immutable historical metadata after verified Cloud attribution and a second source read.
   */
  async bind(request: Coordinates, signal: AbortSignal): Promise<ProjectOperationRuntimeEntryPublication> {
    if (request.sourceEventId !== 'dsh-runtime-entry:' + request.entryId || request.sourceRevision !== '1') unavailable()
    const captured = await this.capture(request.originalCommandId, request.entryId, signal)
    const current = () => {
      captured.current()
      if (Date.now() >= captured.witness.receipt.binding.grantExpiresAt) unavailable()
    }
    current()
    const active = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, captured.witness.receipt.binding.grantExpiresAt - Date.now()))])
    const first = this.mapping(captured.candidate, false), { mapping } = first
    const freshObservation = this.observation(captured, mapping)
    const returned = await this.options.registerObservation(freshObservation, active)
    current()
    const publication = this.acceptPair(captured, first, returned)
    current()
    return publication
  }

  private acceptPair(captured: Awaited<ReturnType<AccountRuntimeEntryOrigin['capture']>>,
    first: ReturnType<AccountRuntimeEntryOrigin['mapping']>, returned: unknown): ProjectOperationRuntimeEntryPublication {
    const { mapping } = first
    const expected = { ...captured.lease.account, botId: captured.candidate.botRootId, peer: captured.lease.peer }
    captured.current()
    if (!returned || typeof returned !== 'object' || Object.getPrototypeOf(returned) !== Object.prototype ||
      Reflect.ownKeys(returned).length !== 2 || !Object.hasOwn(returned, 'observation') || !Object.hasOwn(returned, 'attribution')) unavailable()
    const observation = parseRuntimeEntryObservation(Reflect.get(returned, 'observation'))
    const claim = parseRuntimeEntryAttribution(Reflect.get(returned, 'attribution'))
    const originalKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(observation.peer.publicKey, 'base64url')]), format: 'der', type: 'spki' })
    const identityKeys = ['authorityEnvironmentId', 'accountIssuer', 'accountSubject', 'accountBindingId',
      'accountBindingVersion', 'hostProfileId', 'botId'] as const
    if (identityKeys.some(k => observation[k] !== expected[k]) ||
      observation.peer.installationId !== expected.peer.installationId ||
        observation.peer.publicKey !== expected.peer.publicKey ||
      observation.peer.computerId !== expected.peer.computerId ||
        observation.peer.hostRegistryId !== expected.peer.hostRegistryId ||
      observation.issuer !== captured.lease.issuer ||
        runtimeEntryReceiptDigest(observation.receipt) !== captured.candidate.entryReceiptDigest ||
      observation.readbackDigest !== captured.witness.readbackDigest || !isDeepStrictEqual(observation.sourceEventMapping, mapping) ||
      observation.issuedAt > Date.now() || !verify(null, Buffer.from(encodeRuntimeEntryObservation(observation)), originalKey,
      Buffer.from(observation.signature, 'base64url'))) unavailable()
    const ring = this.options.keyrings.find(r => r.environmentId === claim.authorityEnvironmentId && r.issuer === claim.issuer)
    const key = ring?.keys.find(k => k.kid === claim.keyId), now = Date.now()
    const accountKeys = ['authorityEnvironmentId', 'accountIssuer', 'accountSubject', 'accountBindingId',
      'accountBindingVersion', 'hostProfileId', 'botId', 'requestId'] as const
    if (!key || accountKeys.some(k => claim[k] !== observation[k]) ||
      claim.installationId !== observation.peer.installationId || claim.publicKey !== observation.peer.publicKey ||
      claim.observationDigest !== runtimeEntryObservationDigest(observation) ||
        claim.entryReceiptDigest !== captured.candidate.entryReceiptDigest ||
      claim.manifestDigest !== captured.candidate.manifestDigest || String(claim.entryId) !== String(captured.candidate.entryId) ||
        String(claim.projectId) !== String(captured.candidate.projectId) ||
      claim.sourceEventId !== mapping.sourceEventId || claim.sourceRevision !== mapping.sourceRevision ||
        claim.payloadDigest !== mapping.payloadDigest ||
      runtimeEntryBindingDigest(claim.binding) !== runtimeEntryBindingDigest(observation.receipt.binding) ||
      claim.issuedAt < observation.issuedAt || claim.issuedAt >= observation.expiresAt || claim.issuedAt > now ||
      claim.issuedAt < key.validFrom || claim.expiresAt > key.validUntil ||
      !verify(null, Buffer.from(encodeRuntimeEntryAttribution(claim)), createPublicKey(key.publicKeyPem),
        Buffer.from(claim.signature, 'base64url'))) unavailable()
    const second = this.mapping(captured.candidate, false)
    if (!isDeepStrictEqual(second.mapping, mapping) || first.generation !== second.generation) unavailable()
    captured.current()
    return Object.freeze({ attributionDigest: runtimeEntryAttributionDigest(claim),
      observationDigest: runtimeEntryObservationDigest(observation),
      mappingDigest: runtimeEntrySourceEventMappingDigest(mapping), entryId: captured.candidate.entryId,
      entryReceiptDigest: claim.entryReceiptDigest,
      manifestDigest: claim.manifestDigest, projectId: captured.candidate.projectId, sourceEventId: brandString<ProjectOperationRuntimeEntryPublication['sourceEventId']>(mapping.sourceEventId),
      sourceRevision: mapping.sourceRevision, payloadDigest: mapping.payloadDigest })
  }
}
