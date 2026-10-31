/** Strict saved-output signing fields; parsing does not authenticate an installation. */
import type { HostCollaborationAnalysisReceipt } from './types.ts'

const keys = [
  'schema_version',
  'authority_environment_id',
  'account_binding_handle',
  'authority_binding_version',
  'account_issuer',
  'account_subject',
  'installation_id',
  'installation_public_key',
  'host_instance_id',
  'process_nonce',
  'dispatch',
  'output_digest',
  'signature',
] as const
const grantKeys = [
  'attempt_request_id',
  'plan_id',
  'expected_plan_revision',
  'attempt_id',
  'attempt_fence',
  'input_manifest_digest',
  'source_digest',
  'lease_expires_at',
  'dispatch_granted',
] as const
function reject(): never {
  throw Error('invalid_analysis_receipt')
}
function row(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length
  )
    reject()
  const fields = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(fields).length !== names.length ||
    names.some(k => !fields[k]?.enumerable || !('value' in fields[k]))
  )
    reject()
  return Object.fromEntries(names.map(k => [k, fields[k]?.value]))
}
function text(v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) reject()
  return v
}
const id = /^[!-~]{1,256}$/u,
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  digest = /^[a-f0-9]{64}$/u
function version(v: unknown): string {
  const s = text(v, /^[1-9][0-9]{0,18}$/u)
  if (BigInt(s) > 9223372036854775807n) reject()
  return s
}
function base64(v: unknown, size: number): string {
  const s = text(v, /^[A-Za-z0-9_-]+$/u),
    b = Buffer.from(s, 'base64url')
  if (b.length !== size || b.toString('base64url') !== s) reject()
  return s
}
/**
 * Parse detached bounded output output origin without accepting its claimed installation as trusted.
 * @param value - Exact signed receipt, including original coordinator dispatch fields.
 * @returns Frozen receipt; malformed fields, getters and extra properties reject.
 */
export function parseHostCollaborationAnalysisReceipt(value: unknown): HostCollaborationAnalysisReceipt {
  const r = row(value, keys),
    g = row(r.dispatch, grantKeys)
  if (
    r.schema_version !== 1 ||
    !Number.isSafeInteger(r.authority_binding_version) ||
    (r.authority_binding_version as number) < 1 ||
    g.dispatch_granted !== true
  )
    reject()
  const expiry = text(g.lease_expires_at, /^[0-9TZ:.-]{24}$/u),
    time = Date.parse(expiry)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== expiry) reject()
  return Object.freeze({
    schema_version: 1,
    authority_environment_id: text(r.authority_environment_id, uuid),
    account_binding_handle: text(r.account_binding_handle, id),
    authority_binding_version: r.authority_binding_version as number,
    account_issuer: text(r.account_issuer, /^[!-~]{1,2048}$/u),
    account_subject: text(r.account_subject, uuid),
    installation_id: text(r.installation_id, uuid),
    installation_public_key: base64(r.installation_public_key, 32),
    host_instance_id: text(r.host_instance_id, uuid),
    process_nonce: base64(r.process_nonce, 32),
    dispatch: Object.freeze({
      attempt_request_id: text(g.attempt_request_id, uuid),
      plan_id: text(g.plan_id, id),
      expected_plan_revision: version(g.expected_plan_revision),
      attempt_id: text(g.attempt_id, id),
      attempt_fence: version(g.attempt_fence),
      input_manifest_digest: text(g.input_manifest_digest, digest),
      source_digest: text(g.source_digest, digest),
      lease_expires_at: expiry,
      dispatch_granted: true,
    }),
    output_digest: text(r.output_digest, digest),
    signature: base64(r.signature, 64),
  })
}
/**
 * Encode the fixed installation-signing tuple; no model-owned field selects the signing domain.
 * @param value - Strict receipt; signature itself is excluded from the signing bytes.
 * @returns Exact UTF-8 domain and tuple, shared with the remote verifier.
 */
export function encodeHostCollaborationAnalysisReceiptPayload(value: HostCollaborationAnalysisReceipt): string {
  const r = parseHostCollaborationAnalysisReceipt(value)
  return (
    'dsh-collaboration-analysis-output/v1\0' +
    JSON.stringify([
      ...keys.filter(k => k !== 'signature' && k !== 'dispatch').map(k => r[k]),
      grantKeys.map(k => r.dispatch[k]),
    ])
  )
}
