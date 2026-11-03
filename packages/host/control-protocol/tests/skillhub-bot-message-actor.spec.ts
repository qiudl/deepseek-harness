import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  encodeSkillHubBotMessageActorClaims,
  parseSkillHubBotMessageActorClaims,
  parseSkillHubBotMessageActorInput,
  parseSkillHubBotMessageActorProtectedHeader,
  matchesSkillHubBotMessageActorInput,
  SKILLHUB_BOT_MESSAGE_ACTOR_AUDIENCE,
  SKILLHUB_BOT_MESSAGE_ACTOR_PURPOSE,
  SKILLHUB_BOT_MESSAGE_ACTOR_SCHEMA,
  SKILLHUB_BOT_MESSAGE_ACTOR_JWS_TYPE,
} from '../src/skillhub-bot-message-actor.ts'
import type { SkillHubBotMessageActorClaims } from '../src/skillhub-bot-message-actor.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'

const input = {
  actor_user_id: 'actor-a', environment_id: 'staging',
  person_profile_id: '11111111-1111-4111-8111-111111111111',
  workspace_id: '22222222-2222-4222-8222-222222222222',
  identity_id: '33333333-3333-4333-8333-333333333333', user_auth_version: 7,
  identity_epoch: 8, profile_epoch: 9, workspace_epoch: 10,
  runtime_lease_id: '44444444-4444-4444-8444-444444444444',
  assignment_id: '55555555-5555-4555-8555-555555555555', assignment_generation: 11,
  selection_publication_version: 12, grant_id: '66666666-6666-4666-8666-666666666666',
  computer_id: 'computer-1', connection_id: 'connection-1', target_project_id: 'project-1',
  policy_id: 'policy-1', policy_epoch: 13, policy_digest: 'a'.repeat(64),
  session_id: 'session-1', call_id: 'call-1', root_call_id: 'root-call-1',
  source_message_id: 'message-1', binding_id: 'binding-1', bot_id: 'bot-1', room_id: null,
  logical_operation_key: 'operation-1', request_digest: 'b'.repeat(64),
} as const

describe('SkillHub Bot message actor payload', () => {
  it('accepts only the private message and current Person fence supplied by Slark', () => {
    expect(parseSkillHubBotMessageActorInput(input)).toEqual(input)
    for (const invalid of [
      { ...input, room_id: 'group-1' },
      { ...input, source_message_id: '' },
      { ...input, runtime_lease_id: 'not-a-uuid' },
      { ...input, request_digest: 'b'.repeat(63) },
      { ...input, host_key_id: 'caller-owned' },
    ]) expect(() => parseSkillHubBotMessageActorInput(invalid)).toThrow()
  })

  it('encodes every Host-owned and Server-resolved claim in one fixed payload', () => {
    const claims: SkillHubBotMessageActorClaims = {
      schema_version: SKILLHUB_BOT_MESSAGE_ACTOR_SCHEMA, issuer: 'slark-dsh-host:installation',
      audience: SKILLHUB_BOT_MESSAGE_ACTOR_AUDIENCE, purpose: SKILLHUB_BOT_MESSAGE_ACTOR_PURPOSE,
      token_id: 'proof-1', ...input,
      host_installation_id: '77777777-7777-4777-8777-777777777777',
      host_profile_id: '88888888-8888-4888-8888-888888888888',
      host_binding_generation: 3, host_key_id: 'c'.repeat(64),
      source_principal: { kind: 'human' as const, id: input.actor_user_id },
      issued_at: 1_900_000_000_000, expires_at: 1_900_000_030_000,
    }
    const encoded = encodeSkillHubBotMessageActorClaims(claims)
    expect(JSON.parse(encoded)).toEqual(claims)
    expect(parseSkillHubBotMessageActorClaims(JSON.parse(encoded))).toEqual(claims)
    expect(() => parseSkillHubBotMessageActorClaims({ ...claims,
      source_principal: { kind: 'human', id: 'another-actor' } })).toThrow()
    expect(matchesSkillHubBotMessageActorInput(claims, input)).toBe(true)
    expect(matchesSkillHubBotMessageActorInput({ ...claims, call_id: 'other-call' }, input)).toBe(false)
    expect(() => encodeSkillHubBotMessageActorClaims({ ...claims,
      host_binding_generation: 0 })).toThrow()
  })

  it('round-trips only the exact actor request and bounded compact JWS response', () => {
    const authorization = {
      client_instance_id: randomUUID(), host_instance_id: randomUUID(),
      process_nonce: 'A'.repeat(43), jti: randomUUID(), issued_at: 1000, expires_at: 2000,
    }
    const request = {
      version: 1, type: 'request', request_id: randomUUID(),
      method: 'profile.skillhub_bot_message_actor', params: {
        ...authorization, profile_selector: `${'A'.repeat(43)}.${'A'.repeat(86)}`, input,
      },
    }
    const compactJws = `${'A'.repeat(43)}.${'B'.repeat(86)}.${'C'.repeat(86)}`
    const result = {
      version: 1, type: 'result', request_id: randomUUID(),
      method: 'profile.skillhub_bot_message_actor', result: { compact_jws: compactJws },
    }
    const decode = (frame: object) => decodeHostControlFrame(`${JSON.stringify(frame)}\n`)
    for (const frame of [request, result]) {
      expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
    }
    expect(() => decode({ ...request, params: { ...request.params,
      input: { ...input, source_message_id: '' } } })).toThrow()
    for (const compact_jws of [7, 'A.B.C', `${'A'.repeat(16_385)}.B.C`,
      `${'A'.repeat(43)}.${'B'.repeat(86)}.${'C'.repeat(85)}!`]) {
      expect(() => decode({ ...result, result: { compact_jws } })).toThrow()
    }
  })

  it('accepts only the fixed V3 EdDSA protected header', () => {
    const header = { alg: 'EdDSA', typ: SKILLHUB_BOT_MESSAGE_ACTOR_JWS_TYPE,
      version: 3, kid: 'c'.repeat(64) }
    expect(parseSkillHubBotMessageActorProtectedHeader(header)).toEqual(header)
    expect(() => parseSkillHubBotMessageActorProtectedHeader({ ...header, alg: 'none' })).toThrow()
  })
})
