/**
 * Bounded owner-side semantic export for migration consumers. The service reads
 * logical sessions through the JSONL backend, so compression and packed rows
 * never cross the control protocol.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/migration-export
 */

import { createHash, randomBytes } from 'node:crypto'
import { migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionInspection, SessionPersistenceRevision, SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'

const HEX_256 = /^[a-f0-9]{64}$/u
const MAX_CHUNK_BYTES = 48 * 1024
const HARD_MAX_RECORDS = 1_000_000
const HARD_MAX_BYTES = 256 * 1024 * 1024
const EXPORT_TTL_MS = 5 * 60_000

/** Digest-only semantic record safe for the Desktop control protocol. */
export interface MigrationSemanticRecord {
  readonly collection: 'sessions' | 'session_events'
    | 'owner_settings' | 'owner_credentials' | 'owner_workspace' | 'owner_profile'
  readonly id: string
  readonly sessionId?: string
  readonly sequence: number
  readonly payloadDigest: string
}

/** Metadata returned after a stable semantic export has been prepared. */
export interface MigrationExportReceipt {
  readonly exportId: string
  readonly transferId: string
  readonly transferDigest: string
  readonly schemaVersion: number
  readonly sourceGeneration: string
  readonly recordCount: number
  readonly firstEventSequence: number
  readonly lastEventSequence: number
  readonly semanticDigest: string
  readonly chunkCount: number
}

/** Stable logical preflight proof used to bind confirmation to a later export. */
export interface MigrationExportInventoryProof {
  readonly inventoryDigest: string
  readonly sourceGeneration: string
  readonly schemaVersion: number
  readonly requiredMaxRecords: number
  readonly requiredMaxBytes: number
}

/** One idempotently readable control-protocol chunk. */
export interface MigrationExportChunk {
  readonly exportId: string
  readonly chunkIndex: number
  readonly records: readonly MigrationSemanticRecord[]
  readonly chunkDigest: string
  readonly final: boolean
}

/** JSONL operations required by the migration exporter. */
export interface MigrationExportSource {
  inventoryDigest(signal?: AbortSignal): Promise<string>
  readOwnerState(signal?: AbortSignal): Promise<MigrationOwnerStateBundle>
  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>
  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>
  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined>
}

/** Mandatory schema-owned document kinds included in a complete owner migration. */
export type MigrationOwnerStateKind = 'settings' | 'credentials' | 'workspace' | 'profile'

/** Schema-decoded owner state. Secret values stay only in the owner transfer file. */
export interface MigrationOwnerStateBundle {
  readonly version: 1
  readonly documents: readonly Readonly<{
    kind: MigrationOwnerStateKind
    schemaVersion: number
    value: unknown
  }>[]
}

/** Owner-only payload retained outside the Desktop protocol for target import. */
export interface MigrationOwnerTransferBundle {
  readonly version: 1
  readonly schemaVersion: number
  readonly sourceInventoryDigest: string
  readonly sourceGeneration: string
  readonly recordCount: number
  readonly semanticDigest: string
  readonly ownerState: MigrationOwnerStateBundle
  readonly sessions: readonly Readonly<{
    header: SessionHeader
    events: readonly SessionEvent[]
  }>[]
}

interface RetainedExport {
  readonly expiresAt: number
  readonly receipt: MigrationExportReceipt
  readonly chunks: readonly MigrationExportChunk[]
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('migration_export_non_json_value')
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('migration_owner_state_invalid')
  }
  return value as Record<string, unknown>
}

function opaqueId(kind: string, value: string): string {
  return createHash('sha256').update(`${kind}\0${value}`).digest('hex').slice(0, 32)
}

function headerPayload(header: SessionHeader): unknown {
  return {
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    parentSession: header.parentSession,
    seedLength: header.seedLength,
    origin: header.origin,
    delegationDepth: header.delegationDepth,
    agentPreset: header.agentPreset,
    scope: header.scope,
  }
}

function sessionRecord(header: SessionHeader): MigrationSemanticRecord {
  const sessionId = opaqueId('session', header.id)
  return {
    collection: 'sessions',
    id: sessionId,
    sequence: 0,
    payloadDigest: digest(headerPayload(header)),
  }
}

function eventRecord(header: SessionHeader, event: SessionEvent): MigrationSemanticRecord {
  const sessionId = opaqueId('session', header.id)
  return {
    collection: 'session_events',
    id: opaqueId('event', `${header.id}\0${event.seq}`),
    sessionId,
    sequence: event.seq + 1,
    payloadDigest: digest(event),
  }
}

/**
 * Project owner-local decoded sessions to the digest-only protocol view.
 * @param sessions - decoded persistence rows retained inside the Host process.
 * @returns deterministic semantic records without payload content or paths.
 */
export function migrationSemanticRecords(
  sessions: readonly Readonly<{ header: SessionHeader; events: readonly SessionEvent[] }>[],
): MigrationSemanticRecord[] {
  return sessions.flatMap(session => [
    sessionRecord(session.header),
    ...session.events.map(event => eventRecord(session.header, event)),
  ])
}

const OWNER_STATE_KINDS: readonly MigrationOwnerStateKind[] = [
  'credentials', 'profile', 'settings', 'workspace',
]

/**
 * Project owner state into digest-only protocol records.
 * @param ownerState - schema-decoded owner-local documents.
 * @returns deterministic records containing no document payloads.
 */
export function migrationOwnerStateRecords(ownerState: MigrationOwnerStateBundle): MigrationSemanticRecord[] {
  const raw = object(ownerState)
  if (raw.version !== 1 || !Array.isArray(raw.documents)) {
    throw new Error('migration_owner_state_invalid')
  }
  const documents = raw.documents.map((candidate): MigrationOwnerStateBundle['documents'][number] => {
    const document = object(candidate)
    if (!OWNER_STATE_KINDS.includes(document.kind as MigrationOwnerStateKind)
      || !Number.isSafeInteger(document.schemaVersion) || Number(document.schemaVersion) < 1
      || !('value' in document)) throw new Error('migration_owner_state_invalid')
    return {
      kind: document.kind as MigrationOwnerStateKind,
      schemaVersion: document.schemaVersion as number,
      value: document.value,
    }
  }).sort((left, right) => left.kind.localeCompare(right.kind, 'en'))
  if (documents.length !== OWNER_STATE_KINDS.length
    || documents.some((document, index) => document.kind !== OWNER_STATE_KINDS[index])) {
    throw new Error('migration_owner_state_invalid')
  }
  for (const document of documents) {
    const value = object(document.value)
    if (document.kind === 'credentials') {
      const keys = Object.keys(value).sort()
      if (JSON.stringify(keys) !== JSON.stringify(['records', 'refs'])
        || typeof value.refs !== 'object' || value.refs === null || Array.isArray(value.refs)
        || typeof value.records !== 'object' || value.records === null || Array.isArray(value.records)) {
        throw new Error('migration_owner_state_invalid')
      }
    } else if (document.kind === 'workspace') {
      if (!Array.isArray(value.grants) || value.grants.some(grant => typeof grant !== 'string' || !grant.startsWith('/'))) {
        throw new Error('migration_owner_state_invalid')
      }
    } else if (document.kind === 'profile') {
      if (typeof value.name !== 'string' || !['web', 'headless', 'acp', 'sdk', 'sdk-minimal'].includes(value.name)
        || !Array.isArray(value.customPlugins) || value.customPlugins.length !== 0
        || ('externalConnections' in value
          && (!Array.isArray(value.externalConnections) || value.externalConnections.length !== 0))) {
        throw new Error('migration_owner_state_unsupported')
      }
    }
    if (Buffer.byteLength(canonicalJson(document.value)) > 16 * 1024 * 1024) {
      throw new Error('migration_owner_state_too_large')
    }
  }
  return documents.map(document => ({
    collection: `owner_${document.kind}` as MigrationSemanticRecord['collection'],
    id: opaqueId('owner-state', document.kind),
    sequence: 0,
    payloadDigest: digest({ schemaVersion: document.schemaVersion, value: document.value }),
  }))
}

function sameSnapshots(
  left: readonly SessionPersistenceSnapshot[],
  right: readonly SessionPersistenceSnapshot[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((snapshot, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && candidate.header.id === snapshot.header.id
      && candidate.revision === snapshot.revision
  })
}

function sortedSnapshots(snapshots: readonly SessionPersistenceSnapshot[]): SessionPersistenceSnapshot[] {
  return [...snapshots].sort((left, right) => left.header.id.localeCompare(right.header.id, 'en'))
}

/**
 * Compute the canonical logical inventory proof shared by source and exporter.
 * @param snapshots - stable session identities and revisions.
 * @param ownerState - stable schema-decoded owner documents.
 * @returns SHA-256 digest of the complete logical inventory.
 */
export function migrationSourceInventoryDigest(
  snapshots: readonly SessionPersistenceSnapshot[],
  ownerState: MigrationOwnerStateBundle,
): string {
  return digest({
    sessions: sortedSnapshots(snapshots).map(snapshot => ({ id: snapshot.header.id, revision: snapshot.revision })),
    ownerState: migrationOwnerStateRecords(ownerState),
  })
}

/**
 * Retain short-lived, owner-local exports and serve bounded idempotent chunks.
 * A caller must quiesce writers and supply the current owner-computed inventory
 * digest; source revision changes reject the complete export.
 */
export class JsonlMigrationExportService {
  private readonly exports = new Map<string, RetainedExport>()
  private busy = false

  /**
   * @param source - the running JSONL backend that owns schema decoding.
   * @param dependencies - owner-local quiescence, inventory, clock, and entropy operations.
   */
  constructor(
    private readonly source: MigrationExportSource,
    private readonly dependencies: {
      assertQuiescent(signal?: AbortSignal): Promise<void>
      now?: () => number
      randomId?: () => string
      stageOwnerTransfer(bundle: MigrationOwnerTransferBundle, signal?: AbortSignal): Promise<{
        transferId: string
        transferDigest: string
      }>
    },
  ) {}

  /**
   * Produce a quiesced logical preflight proof without retaining payload or an export handle.
   * @param signal - cancellation for schema and persistence reads.
   * @returns bounded inventory facts that a later begin call must revalidate.
   */
  async inventory(signal?: AbortSignal): Promise<MigrationExportInventoryProof> {
    signal?.throwIfAborted()
    await this.dependencies.assertQuiescent(signal)
    const before = sortedSnapshots(await this.source.listSnapshots(signal))
    const ownerState = await this.source.readOwnerState(signal)
    const records = migrationOwnerStateRecords(ownerState)
    for (const snapshot of before) {
      const inspection = await this.source.inspect(snapshot.header.id, signal)
      if (inspection.meta.id !== snapshot.header.id
        || await this.source.readStoredRevision(snapshot.header.id, signal) !== snapshot.revision) {
        throw new Error('migration_source_changed')
      }
      records.push(...migrationSemanticRecords([{ header: inspection.meta, events: inspection.events }]))
    }
    await this.dependencies.assertQuiescent(signal)
    const after = sortedSnapshots(await this.source.listSnapshots(signal))
    if (!sameSnapshots(before, after)) throw new Error('migration_source_changed')
    const inventoryDigest = migrationSourceInventoryDigest(before, ownerState)
    if (await this.source.inventoryDigest(signal) !== inventoryDigest) throw new Error('migration_inventory_changed')
    return Object.freeze({
      inventoryDigest,
      sourceGeneration: inventoryDigest,
      schemaVersion: before[0]?.header.version ?? 0,
      requiredMaxRecords: records.length,
      requiredMaxBytes: Buffer.byteLength(canonicalJson(records)),
    })
  }

  /**
   * Decode a stable logical prefix and retain digest-only records for chunk reads.
   * @param request - caller inventory proof and complete-export bounds.
   * @param signal - cancellation for inventory and persistence reads.
   * @returns stable source metadata and chunk count.
   */
  async begin(
    request: { expectedInventoryDigest: string; maxRecords: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<MigrationExportReceipt> {
    if (
      !HEX_256.test(request.expectedInventoryDigest)
      || !Number.isSafeInteger(request.maxRecords) || request.maxRecords < 1 || request.maxRecords > HARD_MAX_RECORDS
      || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > HARD_MAX_BYTES
    ) throw new Error('migration_export_bounds_invalid')
    this.prune()
    if (this.busy) throw new Error('migration_export_busy')
    this.busy = true
    try {
      signal?.throwIfAborted()
      await this.dependencies.assertQuiescent(signal)
      if (await this.source.inventoryDigest(signal) !== request.expectedInventoryDigest) {
        throw new Error('migration_inventory_changed')
      }
      const before = sortedSnapshots(await this.source.listSnapshots(signal))
      const ownerState = await this.source.readOwnerState(signal)
      const records: MigrationSemanticRecord[] = migrationOwnerStateRecords(ownerState)
      const sessions: Array<{ header: SessionHeader; events: readonly SessionEvent[] }> = []
      let encodedBytes = Buffer.byteLength(canonicalJson(records))
      if (records.length > request.maxRecords || encodedBytes > request.maxBytes) {
        throw new Error('migration_export_too_large')
      }
      for (const snapshot of before) {
        signal?.throwIfAborted()
        const inspection = await this.source.inspect(snapshot.header.id, signal)
        if (inspection.meta.id !== snapshot.header.id) throw new Error('migration_source_changed')
        const additions = migrationSemanticRecords([{ header: inspection.meta, events: inspection.events }])
        sessions.push({ header: structuredClone(inspection.meta), events: structuredClone(inspection.events) })
        for (const record of additions) {
          if (records.length >= request.maxRecords) throw new Error('migration_export_too_large')
          encodedBytes += Buffer.byteLength(canonicalJson(record)) + (records.length === 0 ? 0 : 1)
          if (encodedBytes > request.maxBytes) throw new Error('migration_export_too_large')
          records.push(record)
        }
        if (await this.source.readStoredRevision(snapshot.header.id, signal) !== snapshot.revision) {
          throw new Error('migration_source_changed')
        }
      }
      await this.dependencies.assertQuiescent(signal)
      const after = sortedSnapshots(await this.source.listSnapshots(signal))
      if (!sameSnapshots(before, after)) throw new Error('migration_source_changed')
      if (await this.source.inventoryDigest(signal) !== request.expectedInventoryDigest) {
        throw new Error('migration_inventory_changed')
      }

      const exportId = this.dependencies.randomId?.() ?? randomBytes(24).toString('hex')
      const chunkRecords: MigrationSemanticRecord[][] = []
      for (const record of records) {
        const current = chunkRecords.at(-1) ?? []
        const candidate = [...current, record]
        const response = { exportId, chunkIndex: chunkRecords.length || 0, records: candidate, chunkDigest: '0'.repeat(64), final: false }
        if (Buffer.byteLength(canonicalJson(response)) > MAX_CHUNK_BYTES) {
          if (current.length === 0) throw new Error('migration_export_record_too_large')
          chunkRecords.push([record])
        } else if (chunkRecords.length === 0) {
          chunkRecords.push(candidate)
        } else {
          chunkRecords[chunkRecords.length - 1] = candidate
        }
      }
      if (chunkRecords.length === 0) chunkRecords.push([])
      const chunks = chunkRecords.map((chunk, chunkIndex): MigrationExportChunk => ({
        exportId,
        chunkIndex,
        records: Object.freeze(chunk),
        chunkDigest: digest(chunk),
        final: chunkIndex === chunkRecords.length - 1,
      }))
      for (const chunk of chunks) {
        if (Buffer.byteLength(canonicalJson(chunk)) > MAX_CHUNK_BYTES) throw new Error('migration_export_record_too_large')
      }
      let firstEventSequence = 0
      let lastEventSequence = 0
      for (const record of records) {
        if (record.collection !== 'session_events') continue
        if (firstEventSequence === 0 || record.sequence < firstEventSequence) firstEventSequence = record.sequence
        if (record.sequence > lastEventSequence) lastEventSequence = record.sequence
      }
      const sourceGeneration = migrationSourceInventoryDigest(before, ownerState)
      const semanticDigest = migrationSemanticDigest(records)
      const transfer = await this.dependencies.stageOwnerTransfer(Object.freeze({
        version: 1,
        schemaVersion: before[0]?.header.version ?? 0,
        sourceInventoryDigest: request.expectedInventoryDigest,
        sourceGeneration,
        recordCount: records.length,
        semanticDigest,
        ownerState: structuredClone(ownerState),
        sessions: Object.freeze(sessions),
      }), signal)
      if (!/^[a-f0-9]{32,64}$/u.test(transfer.transferId) || !HEX_256.test(transfer.transferDigest)) {
        throw new Error('migration_transfer_invalid')
      }
      const receipt: MigrationExportReceipt = Object.freeze({
        exportId,
        transferId: transfer.transferId,
        transferDigest: transfer.transferDigest,
        schemaVersion: before[0]?.header.version ?? 0,
        sourceGeneration,
        recordCount: records.length,
        firstEventSequence,
        lastEventSequence,
        semanticDigest,
        chunkCount: chunks.length,
      })
      this.exports.clear()
      this.exports.set(exportId, { expiresAt: this.now() + EXPORT_TTL_MS, receipt, chunks: Object.freeze(chunks) })
      return receipt
    } finally {
      this.busy = false
    }
  }

  /**
   * Return one retained chunk without consuming it.
   * @param request - export handle and zero-based chunk index.
   * @returns the same immutable chunk for every repeated read before expiry.
   */
  read(request: { exportId: string; chunkIndex: number }): MigrationExportChunk {
    this.prune()
    if (!/^[a-f0-9]{32,64}$/u.test(request.exportId) || !Number.isSafeInteger(request.chunkIndex) || request.chunkIndex < 0) {
      throw new Error('migration_export_request_invalid')
    }
    const retained = this.exports.get(request.exportId)
    const chunk = retained?.chunks[request.chunkIndex]
    if (chunk === undefined) throw new Error('migration_export_not_found')
    return chunk
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private prune(): void {
    const now = this.now()
    for (const [exportId, retained] of this.exports) {
      if (retained.expiresAt <= now) this.exports.delete(exportId)
    }
  }
}
