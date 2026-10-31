/** REQ-20261013-0021 T25537. Host-owned DSH Bot message actor payload. */

export const SKILLHUB_BOT_MESSAGE_ACTOR_SCHEMA = 'dsh-slark-bot-message-actor-proof/v3'
/** Audience accepted by the Slark SkillHub Bot verifier. */
export const SKILLHUB_BOT_MESSAGE_ACTOR_AUDIENCE = 'slark-skillhub-bot'
/** Purpose that separates message actor proofs from other Host signatures. */
export const SKILLHUB_BOT_MESSAGE_ACTOR_PURPOSE = 'skillhub.bot-message'
/** Protected-header type for the compact JWS. */
export const SKILLHUB_BOT_MESSAGE_ACTOR_JWS_TYPE = 'SLARK-DSH-BOT-MESSAGE-ACTOR'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const INPUT_KEYS = [
  'actor_user_id', 'environment_id', 'person_profile_id', 'workspace_id', 'identity_id',
  'user_auth_version', 'identity_epoch', 'profile_epoch', 'workspace_epoch',
  'runtime_lease_id', 'assignment_id', 'assignment_generation',
  'selection_publication_version', 'grant_id', 'computer_id', 'connection_id',
  'target_project_id', 'policy_id', 'policy_epoch', 'policy_digest', 'session_id',
  'call_id', 'root_call_id', 'source_message_id', 'binding_id', 'bot_id', 'room_id',
  'logical_operation_key', 'request_digest',
] as const
const CLAIM_KEYS = [
  'schema_version', 'issuer', 'audience', 'purpose', 'token_id', ...INPUT_KEYS.slice(0, 15),
  'host_installation_id', 'host_profile_id', 'host_binding_generation', 'host_key_id',
  'source_principal', ...INPUT_KEYS.slice(15), 'issued_at', 'expires_at',
] as const

/** Server-resolved message and current Person authority that the Host binds to its installation. */
export interface SkillHubBotMessageActorInput {
  readonly actor_user_id: string
  readonly environment_id: string
  readonly person_profile_id: string
  readonly workspace_id: string
  readonly identity_id: string
  readonly user_auth_version: number
  readonly identity_epoch: number
  readonly profile_epoch: number
  readonly workspace_epoch: number
  readonly runtime_lease_id: string
  readonly assignment_id: string
  readonly assignment_generation: number
  readonly selection_publication_version: number
  readonly grant_id: string
  readonly computer_id: string
  readonly connection_id: string
  readonly target_project_id: string
  readonly policy_id: string
  readonly policy_epoch: number
  readonly policy_digest: string
  readonly session_id: string
  readonly call_id: string
  readonly root_call_id: string
  readonly source_message_id: string
  readonly binding_id: string
  readonly bot_id: string
  readonly room_id: null
  readonly logical_operation_key: string
  readonly request_digest: string
}

/** Complete fixed claims signed by one current Host installation/Profile grant. */
export interface SkillHubBotMessageActorClaims extends SkillHubBotMessageActorInput {
  readonly schema_version: typeof SKILLHUB_BOT_MESSAGE_ACTOR_SCHEMA
  readonly issuer: string
  readonly audience: typeof SKILLHUB_BOT_MESSAGE_ACTOR_AUDIENCE
  readonly purpose: typeof SKILLHUB_BOT_MESSAGE_ACTOR_PURPOSE
  readonly token_id: string
  readonly host_installation_id: string
  readonly host_profile_id: string
  readonly host_binding_generation: number
  readonly host_key_id: string
  readonly source_principal: { readonly kind: 'human'; readonly id: string }
  readonly issued_at: number
  readonly expires_at: number
}

/** Exact protected header signed by the Host installation key. */
export interface SkillHubBotMessageActorProtectedHeader {
  readonly alg: 'EdDSA'
  readonly typ: typeof SKILLHUB_BOT_MESSAGE_ACTOR_JWS_TYPE
  readonly version: 3
  readonly kid: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key =>
    Object.prototype.propertyIsEnumerable.call(value, key))
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const nonnegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value)

/**
 * Parse the exact Server-resolved fields accepted by the Host signer.
 * @param value - Untrusted local control-frame value.
 * @returns Detached exact fields with no Host identity or timing supplied by the caller.
 */
export function parseSkillHubBotMessageActorInput(value: unknown): SkillHubBotMessageActorInput {
  if (!record(value) || !exact(value, INPUT_KEYS)
    || !id(value.actor_user_id) || !id(value.environment_id)
    || !uuid(value.person_profile_id) || !uuid(value.workspace_id)
    || !uuid(value.identity_id) || !nonnegative(value.user_auth_version)
    || !positive(value.identity_epoch)
    || !positive(value.profile_epoch) || !positive(value.workspace_epoch)
    || !uuid(value.runtime_lease_id) || !uuid(value.assignment_id)
    || !positive(value.assignment_generation) || !positive(value.selection_publication_version)
    || !uuid(value.grant_id) || !id(value.computer_id)
    || !id(value.connection_id) || !id(value.target_project_id)
    || !id(value.policy_id) || !positive(value.policy_epoch)
    || !digest(value.policy_digest) || !id(value.session_id)
    || !id(value.call_id) || !id(value.root_call_id)
    || !id(value.source_message_id) || !id(value.binding_id)
    || !id(value.bot_id) || value.room_id !== null
    || !id(value.logical_operation_key) || !digest(value.request_digest)) {
    throw new Error('invalid_skillhub_bot_message_actor_input')
  }
  return {
    actor_user_id: value.actor_user_id,
    environment_id: value.environment_id,
    person_profile_id: value.person_profile_id,
    workspace_id: value.workspace_id,
    identity_id: value.identity_id,
    user_auth_version: value.user_auth_version,
    identity_epoch: value.identity_epoch,
    profile_epoch: value.profile_epoch,
    workspace_epoch: value.workspace_epoch,
    runtime_lease_id: value.runtime_lease_id,
    assignment_id: value.assignment_id,
    assignment_generation: value.assignment_generation,
    selection_publication_version: value.selection_publication_version,
    grant_id: value.grant_id,
    computer_id: value.computer_id,
    connection_id: value.connection_id,
    target_project_id: value.target_project_id,
    policy_id: value.policy_id,
    policy_epoch: value.policy_epoch,
    policy_digest: value.policy_digest,
    session_id: value.session_id,
    call_id: value.call_id,
    root_call_id: value.root_call_id,
    source_message_id: value.source_message_id,
    binding_id: value.binding_id,
    bot_id: value.bot_id,
    room_id: null,
    logical_operation_key: value.logical_operation_key,
    request_digest: value.request_digest,
  }
}

/**
 * Parse the complete claims returned by the local Host.
 * @param value - Decoded JWS payload from the control response.
 * @returns Detached claims after exact-field and bounded-lifetime validation.
 */
export function parseSkillHubBotMessageActorClaims(value: unknown): SkillHubBotMessageActorClaims {
  if (!record(value) || !exact(value, CLAIM_KEYS)
    || value.schema_version !== SKILLHUB_BOT_MESSAGE_ACTOR_SCHEMA || !id(value.issuer)
    || value.audience !== SKILLHUB_BOT_MESSAGE_ACTOR_AUDIENCE
    || value.purpose !== SKILLHUB_BOT_MESSAGE_ACTOR_PURPOSE || !id(value.token_id)
    || !uuid(value.host_installation_id) || !uuid(value.host_profile_id)
    || !positive(value.host_binding_generation) || !digest(value.host_key_id)
    || !record(value.source_principal) || !exact(value.source_principal, ['kind', 'id'])
    || value.source_principal.kind !== 'human' || !id(value.source_principal.id)
    || !positive(value.issued_at) || !positive(value.expires_at)
    || value.expires_at <= value.issued_at || value.expires_at - value.issued_at > 60_000) {
    throw new Error('invalid_skillhub_bot_message_actor_claims')
  }
  const input = parseSkillHubBotMessageActorInput(Object.fromEntries(
    INPUT_KEYS.map(key => [key, value[key]]),
  ))
  if (value.source_principal.id !== input.actor_user_id) {
    throw new Error('invalid_skillhub_bot_message_actor_claims')
  }
  return {
    schema_version: value.schema_version, issuer: value.issuer, audience: value.audience,
    purpose: value.purpose, token_id: value.token_id, ...input,
    host_installation_id: value.host_installation_id,
    host_profile_id: value.host_profile_id,
    host_binding_generation: value.host_binding_generation, host_key_id: value.host_key_id,
    source_principal: { kind: 'human', id: value.source_principal.id },
    issued_at: value.issued_at, expires_at: value.expires_at,
  }
}

/**
 * Parse the exact protected header accepted by Slark's V3 verifier.
 * @param value - Decoded protected-header JSON.
 * @returns Detached fixed EdDSA header.
 */
export function parseSkillHubBotMessageActorProtectedHeader(
  value: unknown,
): SkillHubBotMessageActorProtectedHeader {
  if (!record(value) || !exact(value, ['alg', 'typ', 'version', 'kid'])
    || value.alg !== 'EdDSA' || value.typ !== SKILLHUB_BOT_MESSAGE_ACTOR_JWS_TYPE
    || value.version !== 3 || !digest(value.kid)) {
    throw new Error('invalid_skillhub_bot_message_actor_header')
  }
  return { alg: value.alg, typ: value.typ, version: value.version, kid: value.kid }
}

/**
 * Encode claims in the fixed order consumed by Slark's independent JWS verifier.
 * @param claims - Complete Host-owned claims.
 * @returns UTF-8 JSON text for the JWS payload segment.
 */
export function encodeSkillHubBotMessageActorClaims(claims: SkillHubBotMessageActorClaims): string {
  const input = parseSkillHubBotMessageActorClaims(claims)
  return JSON.stringify({
    schema_version: claims.schema_version, issuer: claims.issuer, audience: claims.audience,
    purpose: claims.purpose, token_id: claims.token_id, actor_user_id: input.actor_user_id,
    environment_id: input.environment_id, person_profile_id: input.person_profile_id,
    workspace_id: input.workspace_id, identity_id: input.identity_id,
    user_auth_version: input.user_auth_version, identity_epoch: input.identity_epoch,
    profile_epoch: input.profile_epoch, workspace_epoch: input.workspace_epoch,
    runtime_lease_id: input.runtime_lease_id, assignment_id: input.assignment_id,
    assignment_generation: input.assignment_generation,
    selection_publication_version: input.selection_publication_version, grant_id: input.grant_id,
    computer_id: input.computer_id, host_installation_id: claims.host_installation_id,
    host_profile_id: claims.host_profile_id,
    host_binding_generation: claims.host_binding_generation, host_key_id: claims.host_key_id,
    source_principal: claims.source_principal, connection_id: input.connection_id,
    target_project_id: input.target_project_id, policy_id: input.policy_id,
    policy_epoch: input.policy_epoch, policy_digest: input.policy_digest,
    session_id: input.session_id, call_id: input.call_id, root_call_id: input.root_call_id,
    source_message_id: input.source_message_id, binding_id: input.binding_id,
    bot_id: input.bot_id, room_id: input.room_id,
    logical_operation_key: input.logical_operation_key, request_digest: input.request_digest,
    issued_at: claims.issued_at, expires_at: claims.expires_at,
  })
}

/**
 * Confirm that signed claims preserve every Server-resolved input exactly.
 * @param claims - Parsed Host-signed claims.
 * @param input - Original Server-resolved fields.
 * @returns Whether every caller-owned field is unchanged.
 */
export function matchesSkillHubBotMessageActorInput(
  claims: SkillHubBotMessageActorClaims,
  input: SkillHubBotMessageActorInput,
): boolean {
  return INPUT_KEYS.every(key => claims[key] === input[key])
}
