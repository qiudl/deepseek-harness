/** Native facts about the complete captured text ingress, separate from planning and execution authority. */
import { parseHostRemoteSessionJson } from './codec.ts'

/** Original Root identity and all text-input fields bound to the current Native process. */
export type HostRootTextContextReceipt = Readonly<{
  schema_version: 1
  context_kind: 'text-root-input-v1'
  authority_environment_id: string
  account_binding_handle: string
  authority_binding_version: number
  account_issuer: string
  account_subject: string
  installation_id: string
  installation_public_key: string
  host_instance_id: string
  process_nonce: string
  root: Readonly<{
    namespace_id: string
    root_task_id: string
    root_trace_id: string
    command_id: string
    source_digest: string
    payload_digest: string
  }>
  source_input_digest: string
  signature: string
}>
const rootKeys = ['namespace_id', 'root_task_id', 'root_trace_id', 'command_id', 'source_digest', 'payload_digest'] as const
const authorityKeys = ['authority_environment_id', 'account_binding_handle', 'authority_binding_version',
  'account_issuer', 'account_subject', 'installation_id', 'installation_public_key', 'host_instance_id', 'process_nonce'] as const
const inputKeys = ['workspace_id', 'session_id', 'source_message_id', 'source_revision', 'original_message', 'active_mentions']
function invalid(): never { throw Error('invalid_root_text_context') }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) invalid()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(fields).length !== keys.length
    || keys.some(key => !Object.hasOwn(fields, key))
    || Object.values(fields).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))) invalid()
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) invalid()
  return value
}
const uuid = (value: unknown) => text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
const digest = (value: unknown) => text(value, /^[a-f0-9]{64}$/u)
const nonce = (value: unknown) => text(value, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
/**
 * Encode the entire strict text ingress only after the private Source owner accepts it.
 * @param value - All six original Source fields; attachments and other extra fields reject.
 * @returns Canonical input JSON for hashing, without removing any ingress fields.
 */
export function encodeHostRootTextInput(value: unknown): string {
  const input = exact(value, inputKeys)
  return canonical(parseHostRemoteSessionJson(input))
}
/**
 * Validate exact Account, Native process, Root and complete-input facts without trusting the signature.
 * @param value - Native-signed text capture metadata, never a planning manifest or grant.
 * @returns Detached frozen receipt; callers still check the current peer and actual Source input.
 */
export function parseHostRootTextContextReceipt(value: unknown): HostRootTextContextReceipt {
  const row = exact(value, ['schema_version', 'context_kind', ...authorityKeys, 'root', 'source_input_digest', 'signature'])
  const root = exact(row.root, rootKeys)
  if (row.schema_version !== 1 || row.context_kind !== 'text-root-input-v1'
    || !Number.isSafeInteger(row.authority_binding_version) || (row.authority_binding_version as number) < 1) invalid()
  const issuer = text(row.account_issuer, /^https:\/\/[^\s]{1,2040}$/u)
  if (new URL(issuer).origin !== issuer) invalid()
  const handle = text(row.account_binding_handle, /^[^\u0000-\u001f\u007f]{1,512}$/u)
  if (!handle.isWellFormed()) invalid()
  const installation = uuid(row.installation_id), host = uuid(row.host_instance_id)
  if (installation === host) invalid()
  return Object.freeze({ schema_version: 1, context_kind: 'text-root-input-v1',
    authority_environment_id: uuid(row.authority_environment_id), account_binding_handle: handle,
    authority_binding_version: row.authority_binding_version as number, account_issuer: issuer, account_subject: uuid(row.account_subject),
    installation_id: installation, installation_public_key: nonce(row.installation_public_key), host_instance_id: host,
    process_nonce: nonce(row.process_nonce), root: Object.freeze({
      namespace_id: text(root.namespace_id, /^n2_[a-f0-9]{64}$/u), root_task_id: uuid(root.root_task_id),
      root_trace_id: text(root.root_trace_id, /^(?!0{32}$)[a-f0-9]{32}$/u), command_id: uuid(root.command_id),
      source_digest: digest(root.source_digest), payload_digest: digest(root.payload_digest),
    }), source_input_digest: digest(row.source_input_digest), signature: text(row.signature, /^[A-Za-z0-9_-]{85}[AQgw]$/u) })
}
/**
 * Encode a separate fixed-order signing domain binding the complete ingress to its original Root.
 * @param value - Parsed receipt; the signature is excluded from these bytes.
 * @returns UTF-8 signing text; it conveys no planning, read or execution permission.
 */
export function encodeHostRootTextContextPayload(value: HostRootTextContextReceipt): string {
  const row = parseHostRootTextContextReceipt(value)
  return 'dsh-root-text-context/v1\0' + JSON.stringify([row.schema_version, row.context_kind,
    ...authorityKeys.map(key => row[key]), ...rootKeys.map(key => row.root[key]), row.source_input_digest])
}
