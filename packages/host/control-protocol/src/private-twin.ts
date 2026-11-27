/** Bounded transfer frames for one live, Account-bound private-twin invocation. */
import { parseHostBindingIntentProof, parseHostBindingReceiptProof, parseHostBindingRegistration, parseHostBindingLookupId,
  type HostBindingIntentProof, type HostBindingReceiptProof, type HostBindingRegistration } from './private-binding-intent.ts'
export const PRIVATE_TWIN_CONTROL_CHUNK_BYTES = 24 * 1024
/** Maximum serialized tool request, including JSON escaping. */
export const PRIVATE_TWIN_CONTROL_REQUEST_BYTES = 6 * 32_000 + 8192
/** Maximum serialized tool result, including JSON escaping. */
export const PRIVATE_TWIN_CONTROL_RESULT_BYTES = 6 * 128 * 1024 + 8192

interface PrivateTwinTransfer {
  readonly ticket: string
  readonly total_bytes: number
  readonly digest: string
}

/** Main requests one claim, ticket check, request chunk, or result upload. */
export type HostPrivateTwinCommand =
  | { readonly operation: 'claim'; readonly binding_profile_epoch?: true }
  | { readonly operation: 'check'; readonly ticket: string }
  | { readonly operation: 'read'; readonly ticket: string; readonly offset: number }
  | { readonly operation: 'sign_binding'; readonly ticket: string; readonly registration: HostBindingRegistration }
  | { readonly operation: 'sign_binding_receipt'; readonly ticket: string; readonly registration: HostBindingRegistration; readonly lookup_id: string }
  | ({ readonly operation: 'finish'; readonly offset: number; readonly bytes: string } & PrivateTwinTransfer)

/** Host returns a ticket state, claim metadata, or one request fragment. */
export type HostPrivateTwinResult =
  | { readonly state: 'idle' }
  | ({ readonly state: 'claimed'; readonly profile_id: string; readonly binding_profile_epoch?: number } & PrivateTwinTransfer)
  | { readonly state: 'current'; readonly ticket: string }
  | { readonly state: 'chunk'; readonly ticket: string; readonly offset: number; readonly bytes: string }
  | { readonly state: 'staged'; readonly ticket: string; readonly next_offset: number }
  | { readonly state: 'completed'; readonly ticket: string }
  | { readonly state: 'binding_intent'; readonly ticket: string; readonly proof: HostBindingIntentProof }
  | { readonly state: 'binding_receipt'; readonly ticket: string; readonly proof: HostBindingReceiptProof }

const profileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const invalid = (): never => { throw Error('invalid_host_private_twin_frame') }

function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const keys = Reflect.ownKeys(value)
  if (fields && (keys.length !== fields.length || fields.some(key => !keys.includes(key)))) return invalid()
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !d?.enumerable || !('value' in d)) return invalid()
  }
  return value as Record<string, unknown>
}

function base64(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(max * 4 / 3)) return invalid()
  const decoded = Buffer.from(value, 'base64url')
  if (!decoded.length || decoded.length > max || decoded.toString('base64url') !== value) return invalid()
  return value
}

function ticket(value: unknown): string {
  const selected = base64(value, 32)
  return selected.length === 43 ? selected : invalid()
}

function bounded(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid()
  return value
}

function transfer(row: Record<string, unknown>, max: number): PrivateTwinTransfer {
  if (typeof row.digest !== 'string' || /^[a-f0-9]{64}$/u.exec(row.digest)?.[0] !== row.digest) return invalid()
  return { ticket: ticket(row.ticket), total_bytes: bounded(row.total_bytes, 1, max), digest: row.digest }
}

/**
 * Validate a bounded transfer command.
 * @param value - Untrusted control frame payload.
 * @returns A detached command with an exact shape.
 */
export function parseHostPrivateTwinCommand(value: unknown): HostPrivateTwinCommand {
  const row = record(value)
  const { operation } = row
  switch (operation) {
    case 'claim':
      if (!Object.hasOwn(row, 'binding_profile_epoch')) {
        record(row, ['operation'])
        return { operation }
      }
      record(row, ['operation', 'binding_profile_epoch'])
      return row.binding_profile_epoch === true ? { operation, binding_profile_epoch: true } : invalid()
    case 'check':
      record(row, ['operation', 'ticket'])
      return { operation, ticket: ticket(row.ticket) }
    case 'read':
      record(row, ['operation', 'ticket', 'offset'])
      return { operation, ticket: ticket(row.ticket), offset: bounded(row.offset, 0, PRIVATE_TWIN_CONTROL_REQUEST_BYTES - 1) }
    case 'sign_binding':
      record(row, ['operation', 'ticket', 'registration'])
      return { operation, ticket: ticket(row.ticket), registration: parseHostBindingRegistration(row.registration) }
    case 'sign_binding_receipt':
      record(row, ['operation', 'ticket', 'registration', 'lookup_id'])
      return { operation, ticket: ticket(row.ticket), registration: parseHostBindingRegistration(row.registration),
        lookup_id: parseHostBindingLookupId(row.lookup_id) }
    case 'finish': {
      record(row, ['operation', 'ticket', 'offset', 'total_bytes', 'digest', 'bytes'])
      const header = transfer(row, PRIVATE_TWIN_CONTROL_RESULT_BYTES)
      const offset = bounded(row.offset, 0, header.total_bytes - 1)
      const bytes = base64(row.bytes, Math.min(PRIVATE_TWIN_CONTROL_CHUNK_BYTES, header.total_bytes - offset))
      return { operation, ...header, offset, bytes }
    }
    default: return invalid()
  }
}

/**
 * Validate a bounded transfer response received over the control connection.
 * @param value - Untrusted response payload.
 * @returns A detached response with an exact shape.
 */
export function parseHostPrivateTwinResult(value: unknown): HostPrivateTwinResult {
  const row = record(value)
  const { state } = row
  switch (state) {
    case 'idle':
      record(row, ['state'])
      return { state }
    case 'claimed': {
      const epoch = Object.hasOwn(row, 'binding_profile_epoch')
        ? bounded(row.binding_profile_epoch, 1, Number.MAX_SAFE_INTEGER) : undefined
      record(row, ['state', 'ticket', 'total_bytes', 'digest', 'profile_id',
        ...(epoch === undefined ? [] : ['binding_profile_epoch'])])
      const { profile_id } = row
      if (typeof profile_id !== 'string'
        || profileIdPattern.exec(profile_id)?.[0] !== profile_id) return invalid()
      return { state, ...transfer(row, PRIVATE_TWIN_CONTROL_REQUEST_BYTES), profile_id,
        ...(epoch === undefined ? {} : { binding_profile_epoch: epoch }) }
    }
    case 'chunk':
      record(row, ['state', 'ticket', 'offset', 'bytes'])
      return { state, ticket: ticket(row.ticket), offset: bounded(row.offset, 0, PRIVATE_TWIN_CONTROL_REQUEST_BYTES - 1),
        bytes: base64(row.bytes, PRIVATE_TWIN_CONTROL_CHUNK_BYTES) }
    case 'staged':
      record(row, ['state', 'ticket', 'next_offset'])
      return { state, ticket: ticket(row.ticket), next_offset: bounded(row.next_offset, 1, PRIVATE_TWIN_CONTROL_RESULT_BYTES - 1) }
    case 'current': case 'completed':
      record(row, ['state', 'ticket'])
      return { state, ticket: ticket(row.ticket) }
    case 'binding_intent':
      record(row, ['state', 'ticket', 'proof'])
      return { state, ticket: ticket(row.ticket), proof: parseHostBindingIntentProof(row.proof) }
    case 'binding_receipt':
      record(row, ['state', 'ticket', 'proof'])
      return { state, ticket: ticket(row.ticket), proof: parseHostBindingReceiptProof(row.proof) }
    default: return invalid()
  }
}
