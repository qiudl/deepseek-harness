/** Exact Host installation proof for one durable external Bot result. */
import { parseHostBotGroupResponse, type HostBotGroupResponse } from './bot-group.js'

type Result = Extract<HostBotGroupResponse, { state: 'ok' }>['results'][number]
/** Installation-signed result bound to one Account, Host process and Bot delivery. */
export interface HostBotGroupResultProof {
  readonly schema_version: 1
  readonly authority_environment_id: string
  readonly account_binding_handle: string
  readonly authority_binding_version: number
  readonly account_issuer: string
  readonly account_subject: string
  readonly owner_user_id: string
  readonly computer_id: string
  readonly slark_audience: string
  readonly installation_id: string
  readonly installation_public_key: string
  readonly host_instance_id: string
  readonly process_nonce: string
  readonly result: Result
  readonly issued_at: number
  readonly signature: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const OPAQUE = /^[\x21-\x7e]{1,256}$/u
const SIG = /^[A-Za-z0-9_-]{86}$/u
const fail = (): never => { throw Error('invalid_bot_group_result_proof') }

/**
 * Validate the exact signed proof shape and its nested result.
 * @param value - Untrusted Host frame value.
 * @returns Validated proof.
 */
export function parseHostBotGroupResultProof(value: unknown): HostBotGroupResultProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const row = value as Record<string, unknown>
  const fields = ['schema_version', 'authority_environment_id', 'account_binding_handle',
    'authority_binding_version', 'account_issuer', 'account_subject', 'owner_user_id',
    'computer_id', 'slark_audience', 'installation_id', 'installation_public_key',
    'host_instance_id', 'process_nonce', 'result', 'issued_at', 'signature']
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field)) ||
    row.schema_version !== 1 || typeof row.authority_environment_id !== 'string' ||
    !UUID.test(row.authority_environment_id) || typeof row.account_binding_handle !== 'string' ||
    !OPAQUE.test(row.account_binding_handle) ||
    !Number.isSafeInteger(row.authority_binding_version) || Number(row.authority_binding_version) < 1 ||
    typeof row.account_issuer !== 'string' || !OPAQUE.test(row.account_issuer) ||
    typeof row.account_subject !== 'string' || !OPAQUE.test(row.account_subject) ||
    typeof row.owner_user_id !== 'string' || !OPAQUE.test(row.owner_user_id) ||
    typeof row.computer_id !== 'string' || !OPAQUE.test(row.computer_id) ||
    typeof row.slark_audience !== 'string' || !OPAQUE.test(row.slark_audience) ||
    typeof row.installation_id !== 'string' || !UUID.test(row.installation_id) ||
    typeof row.installation_public_key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(row.installation_public_key) ||
    typeof row.host_instance_id !== 'string' || !UUID.test(row.host_instance_id) ||
    typeof row.process_nonce !== 'string' || !OPAQUE.test(row.process_nonce) ||
    !Number.isSafeInteger(row.issued_at) || Number(row.issued_at) < 1 ||
    typeof row.signature !== 'string' || !SIG.test(row.signature)) fail()
  const result = row.result as Result
  // The parser returns `ok` with this one result or throws; it cannot return
  // another state for the fixed input above.
  const parsed = parseHostBotGroupResponse({ state: 'ok', results: [result], next: result.seq }) as
    Extract<HostBotGroupResponse, { state: 'ok' }>
  return {
    schema_version: 1, authority_environment_id: row.authority_environment_id as string,
    account_binding_handle: row.account_binding_handle as string,
    authority_binding_version: row.authority_binding_version as number,
    account_issuer: row.account_issuer as string, account_subject: row.account_subject as string,
    owner_user_id: row.owner_user_id as string, computer_id: row.computer_id as string,
    slark_audience: row.slark_audience as string, installation_id: row.installation_id as string,
    installation_public_key: row.installation_public_key as string,
    host_instance_id: row.host_instance_id as string, process_nonce: row.process_nonce as string,
    result: parsed.results[0] as Result, issued_at: row.issued_at as number, signature: row.signature as string,
  }
}

/**
 * Encode the fixed ordered payload shared with Slark's independent verifier.
 * @param value - Proof fields before signing.
 * @returns UTF-8 signature payload.
 */
export function encodeHostBotGroupResultProofPayload(value: Omit<HostBotGroupResultProof, 'signature'>): Uint8Array {
  const result = value.result
  return Buffer.from(JSON.stringify(['slark-bot-group-result-v1', value.schema_version,
    value.authority_environment_id, value.account_binding_handle,
    value.authority_binding_version, value.account_issuer, value.account_subject,
    value.owner_user_id, value.computer_id, value.slark_audience,
    value.installation_id, value.installation_public_key,
    value.host_instance_id, value.process_nonce,
    result.id, result.deliveryId, result.groupId, result.botId,
    result.memberCycle, result.seq, result.status, result.text,
    value.issued_at]), 'utf8')
}
