/** Internal frozen-v3 scalar and tuple validation; parsed data establishes no authority. */
import { createHash } from 'node:crypto'
import type { HostControlSha256, HostControlRequestId } from './types.ts'
import type {
  HostProjectOperationReference,
  HostProjectOperationSequence,
  HostProjectOperationVersion,
} from './project-operation-event.ts'
import { array, record, text, id, uuid, version, digest, time } from './twin-binding-validation.ts'

type Parser = (value: unknown) => unknown
type Parsed<S extends Record<string, Parser>> = Readonly<{ [K in keyof S]: ReturnType<S[K]> }>

/**
 * Reject unsupported wire values.
 * @returns Never returns.
 */
export function invalid(): never {
  throw Error('invalid_project_operation_memory')
}
/**
 * Parse an exact own-data object.
 * @param value - Untrusted JSON.
 * @param schema - Complete field parsers.
 * @returns Detached frozen fields.
 */
export function object<S extends Record<string, Parser>>(value: unknown, schema: S): Parsed<S> {
  const raw = record(value, Object.keys(schema))
  return Object.freeze(
    Object.fromEntries(Object.entries(schema).map(([key, parse]) => [key, parse(raw[key])])),
  ) as Parsed<S>
}
/**
 * Read a discriminant without executing getters.
 * @param value - Untrusted JSON object.
 * @param key - Own data field.
 * @returns The field value.
 */
export function discriminant(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid()
  return field.value
}
/**
 * Parse a closed literal.
 * @param value - Untrusted scalar.
 * @param choices - Allowed literals.
 * @returns A supported literal.
 */
export function choice<const T extends readonly (string | number)[]>(value: unknown, choices: T): T[number] {
  for (const item of choices) if (value === item) return item
  return invalid()
}
/**
 * Parse explicit null or a value.
 * @param value - Untrusted scalar.
 * @param parse - Non-null parser.
 * @returns Null or parsed data.
 */
export function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === null ? null : parse(value)
}
/**
 * Parse a bounded immutable list.
 * @param value - Untrusted array.
 * @param max - Item limit.
 * @param parse - Item parser.
 * @returns Detached frozen items.
 */
export function list<T>(value: unknown, max: number, parse: (v: unknown) => T): readonly T[] {
  return Object.freeze(array(value, max, parse))
}
/**
 * Parse an opaque ASCII reference.
 * @param value - Untrusted reference.
 * @returns Branded reference.
 */
export function reference(value: unknown): HostProjectOperationReference {
  return id(value) as HostProjectOperationReference
}
/**
 * Parse an opaque UUID.
 * @param value - Untrusted identifier.
 * @returns Branded identifier.
 */
export function identifier(value: unknown): HostProjectOperationReference {
  return uuid(value) as HostProjectOperationReference
}
/**
 * Parse a request UUID.
 * @param value - Untrusted request identifier.
 * @returns The existing branded request identity.
 */
export function requestId(value: unknown): HostControlRequestId {
  return uuid(value) as HostControlRequestId
}
/**
 * Parse a positive int64 version.
 * @param value - Untrusted version.
 * @returns Exact branded decimal.
 */
export function revision(value: unknown): HostProjectOperationVersion {
  return version(value) as HostProjectOperationVersion
}
/**
 * Parse a nonnegative int64 scan coordinate.
 * @param value - Untrusted sequence.
 * @returns Exact branded decimal.
 */
export function sequence(value: unknown): HostProjectOperationSequence {
  const result = text(value, /^(0|[1-9][0-9]{0,18})$/u)
  if (BigInt(result) > 9223372036854775807n) return invalid()
  return result as HostProjectOperationSequence
}
/**
 * Parse a SHA256 digest.
 * @param value - Untrusted digest.
 * @returns Branded lowercase digest.
 */
export function sha(value: unknown): HostControlSha256 {
  return digest(value) as HostControlSha256
}
/**
 * Hash declared JSON array bytes.
 * @param name - Frozen purpose.
 * @param fields - Declared-order array.
 * @returns SHA256 digest.
 */
export function hash(name: string, fields: readonly unknown[]): HostControlSha256 {
  return createHash('sha256')
    .update('slark.project-operation-memory.' + name + '/v1\0' + JSON.stringify(fields))
    .digest('hex') as HostControlSha256
}
/**
 * Parse bounded integer data.
 * @param value - Untrusted number.
 * @param min - Inclusive minimum.
 * @param max - Inclusive maximum.
 * @returns Safe integer.
 */
export function integer(value: unknown, min: number, max: number): number {
  const n = time(value)
  if (n < min || n > max) return invalid()
  return n
}
/**
 * Parse a boolean without coercion.
 * @param value - Untrusted scalar.
 * @returns Boolean.
 */
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}
/**
 * Parse canonical unpadded base64url bytes.
 * @param value - Encoded bytes.
 * @param min - Minimum decoded length.
 * @param max - Maximum decoded length.
 * @returns Canonical encoding.
 */
export function base64(value: unknown, min: number, max: number): string {
  const s = text(value, /^[A-Za-z0-9_-]*$/u)
  if (s.length > Math.ceil((max * 8) / 6)) return invalid()
  const bytes = Buffer.from(s, 'base64url')
  if (bytes.length < min || bytes.length > max || bytes.toString('base64url') !== s) return invalid()
  return s
}
/**
 * Parse a nullable opaque cursor.
 * @param value - Cursor bytes or explicit null.
 * @returns Canonical cursor, at most 4096 encoded bytes.
 */
export function cursor(value: unknown): HostProjectOperationReference | null {
  if (value === null) return null
  const result = base64(value, 1, 3072)
  return result as HostProjectOperationReference
}
/**
 * Parse bounded Unicode text without normalization.
 * @param value - Untrusted text.
 * @param min - Minimum UTF8 bytes.
 * @param max - Maximum UTF8 bytes.
 * @returns Original text.
 */
export function utf8(value: unknown, min: number, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) < min ||
    Buffer.byteLength(value) > max
  )
    return invalid()
  return value
}
/**
 * Parse an HTTPS origin issuer.
 * @param value - Untrusted issuer.
 * @returns Exact origin.
 */
export function issuer(value: unknown): string {
  const result = text(value, /^https:\/\/[!-~]{1,2040}$/u)
  if (new URL(result).origin !== result) return invalid()
  return result
}
/**
 * Enforce sorted unique wire tuples.
 * @param items - Parsed items.
 * @param key - Lexical tuple key.
 * @returns Original immutable list.
 */
export function ordered<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  for (let i = 1; i < items.length; i++) if (key(items[i - 1] as T) >= key(items[i] as T)) return invalid()
  return items
}
/**
 * Enforce complete serialized byte budgets.
 * @param value - Parsed JSON data.
 * @param maximum - UTF8 byte budget.
 * @returns The parsed value.
 */
export function budget<T>(value: T, maximum: number): T {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) return invalid()
  return value
}
/**
 * Parse the shared checkpoint.
 * @param value - Untrusted own data.
 * @returns A checkpoint without durable-progress authority.
 */
export function checkpoint(
  value: unknown,
): Readonly<{
  journalEpoch: HostProjectOperationReference
  sequence: HostProjectOperationSequence
  scopeDigest: HostControlSha256
  recipientDigest: HostControlSha256
}> {
  return object(value, { journalEpoch: reference, sequence, scopeDigest: sha, recipientDigest: sha })
}
/**
 * Encode a checkpoint tuple.
 * @param c - Parsed checkpoint.
 * @returns Declared-order fields.
 */
export function checkpointFields(c: ReturnType<typeof checkpoint>): readonly unknown[] {
  return [c.journalEpoch, c.sequence, c.scopeDigest, c.recipientDigest]
}
/**
 * Encode a full event tuple, including its validated payloadDigest.
 * @param value - Parsed event.
 * @returns Frozen-v3 declared-order fields.
 */
export function eventFields(
  value: import('./project-operation-event.ts').HostProjectOperationEvent,
): readonly unknown[] {
  const l = value.sourceLocator,
    c = value.content
  return [
    value.originSide,
    value.originActorRef,
    value.sourceEventId,
    value.sourceRevision,
    value.sourceSequence,
    value.projectId,
    value.occurredAt,
    value.kind,
    value.payloadDigest,
    value.taskRef,
    value.stepRef,
    value.invocationRef,
    value.evidenceRef,
    value.sourcePolicy,
    l === null ? null : [l.providerId, l.sourceEventId, l.sourceRevision, l.sourceDigest],
    value.materialDependencies.map(d => [d.rightId, d.generation, d.revision]),
    c === null
      ? null
      : [
        c.goalSummary,
        c.operationSummary,
        c.outcome,
        c.resultSummary,
        c.failureCode,
        c.unfinishedRefs,
        c.verification,
      ],
  ]
}
