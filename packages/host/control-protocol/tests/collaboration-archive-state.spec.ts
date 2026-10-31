import { expect, it } from 'vitest'
import {
  decodeHostControlFrame, encodeHostControlFrame,
  parseHostCollaborationArchiveIntentTarget, parseHostCollaborationArchiveIntentValue,
  encodeHostCollaborationArchiveStatePayload,
  parseHostCollaborationArchiveStateAssertion,
  parseHostCollaborationArchiveStateChallenge,
  parseHostCollaborationArchiveStateTarget, parseHostCollaborationArchiveStateValue,
} from '../src/index.ts'

it('recovers only an Account-bound original token or explicit absence', () => {
  const c = challenge()
  const target = { workspace_id: c.workspace_id, session_id: c.session_id,
    environment_id: c.environment_id, account_issuer: c.account_issuer,
    account_subject: c.account_subject }
  const request = { version: 1, type: 'request', request_id: c.request_id,
    method: 'profile.collaboration_archive_intent', params: {
      client_instance_id: c.request_id, host_instance_id: assertion().host_instance_id,
      process_nonce: 'A'.repeat(43), jti: c.workspace_id, issued_at: 1000, expires_at: 2000,
      authority_environment_id: c.environment_id,
      account_binding_handle: 'binding:test', authority_binding_version: 1,
      account_issuer: c.account_issuer, account_subject: c.account_subject, target,
    } }
  expect(decodeHostControlFrame(encodeHostControlFrame(request as never))).toEqual(request)
  for (const result of [{ archive_phase: 'missing', archive_token: null },
    { archive_phase: 'prepared', archive_token: c.archive_token }]) {
    const frame = { version: 1, type: 'result', request_id: c.request_id,
      method: request.method, result }
    expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  }
  expect(() => parseHostCollaborationArchiveIntentTarget({ ...target, archive_token: c.archive_token })).toThrow()
  expect(() => parseHostCollaborationArchiveIntentValue({ archive_phase: 'missing', archive_token: c.archive_token })).toThrow()
  expect(() => parseHostCollaborationArchiveIntentValue({ archive_phase: 'archived', archive_token: null })).toThrow()
})

const challenge = () => ({
  request_id: '10000000-0000-4000-8000-000000000001',
  challenge_nonce: 'A'.repeat(43), expires_at: 2000,
  audience: 'https://slark.example.test',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test',
  account_subject: '30000000-0000-4000-8000-000000000003',
  workspace_id: '40000000-0000-4000-8000-000000000004',
  session_id: 'source-session',
  archive_token: '70000000-0000-4000-8000-000000000007',
  archive_phase: 'archived',
})
const assertion = () => ({
  schema_version: 1, challenge: challenge(),
  installation_id: '50000000-0000-4000-8000-000000000005',
  installation_public_key: 'A'.repeat(43),
  host_instance_id: '60000000-0000-4000-8000-000000000006',
  process_nonce: 'A'.repeat(43), signature: 'A'.repeat(86),
})

it('uses a separate signing domain and binds token and durable phase', () => {
  const value = parseHostCollaborationArchiveStateAssertion(assertion())
  expect(encodeHostCollaborationArchiveStatePayload(value).toString()).toBe(
    'dsh-collaboration-archive-state/v1\0' + JSON.stringify([
      1, ...Object.values(challenge()), value.installation_id,
      value.installation_public_key, value.host_instance_id, value.process_nonce,
    ]),
  )
  expect(Object.isFrozen(value.challenge)).toBe(true)
})

it('rejects altered token, phase and extra authority fields', () => {
  expect(() => parseHostCollaborationArchiveStateAssertion({ ...assertion(), schema_version: 2 })).toThrow()
  const c = challenge()
  const target = { workspace_id: c.workspace_id, session_id: c.session_id,
    archive_token: c.archive_token, environment_id: c.environment_id,
    account_issuer: c.account_issuer, account_subject: c.account_subject }
  expect(() => parseHostCollaborationArchiveStateTarget({ ...target, archive_token: 'bad' })).toThrow()
  expect(parseHostCollaborationArchiveStateValue({ archive_phase: 'archived' })).toEqual({ archive_phase: 'archived' })
  expect(() => parseHostCollaborationArchiveStateValue({ archive_phase: 'released' })).toThrow()
  const { archive_token: _token, ...intent } = target
  expect(() => parseHostCollaborationArchiveIntentTarget({ ...intent, account_subject: '' })).toThrow()
  for (const change of [
    { archive_token: 'invalid' }, { archive_phase: 'committed' },
    { extra: 'browser' },
  ]) expect(() => parseHostCollaborationArchiveStateChallenge({ ...challenge(), ...change })).toThrow()
  expect(() => parseHostCollaborationArchiveStateAssertion({ ...assertion(), archive_phase: 'restored' })).toThrow()
  const original = encodeHostCollaborationArchiveStatePayload(parseHostCollaborationArchiveStateAssertion(assertion()))
  for (const change of [
    { archive_token: '80000000-0000-4000-8000-000000000008' },
    { archive_phase: 'restored' },
  ]) {
    const altered = parseHostCollaborationArchiveStateAssertion({ ...assertion(), challenge: { ...challenge(), ...change } })
    expect(encodeHostCollaborationArchiveStatePayload(altered).equals(original)).toBe(false)
  }
})

it('roundtrips only the private account-bound request and signed result', () => {
  const request = {
    version: 1, type: 'request', request_id: challenge().request_id,
    method: 'profile.collaboration_archive_state',
    params: {
      client_instance_id: challenge().request_id,
      host_instance_id: assertion().host_instance_id,
      process_nonce: 'A'.repeat(43),
      jti: challenge().workspace_id,
      issued_at: 1000, expires_at: 2000,
      account_binding_handle: 'binding:test', authority_binding_version: 1,
      challenge: challenge(),
    },
  }
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: request.method, result: assertion() }
  for (const frame of [request, result]) {
    expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  }
  expect(() => decodeHostControlFrame(encodeHostControlFrame({ ...request,
    params: { ...request.params, archive_phase: 'restored' } } as never))).toThrow()
})

it('accepts only an account-bound archive transition with a bounded action and result', () => {
  const { archive_phase: _phase, ...identity } = challenge()
  const request = {
    version: 1, type: 'request', request_id: challenge().request_id,
    method: 'profile.collaboration_archive_transition',
    params: {
      client_instance_id: challenge().request_id,
      host_instance_id: assertion().host_instance_id,
      process_nonce: 'A'.repeat(43), jti: challenge().workspace_id,
      issued_at: 1000, expires_at: 2000,
      authority_environment_id: challenge().environment_id,
      account_binding_handle: 'binding:test', authority_binding_version: 1,
      account_issuer: challenge().account_issuer, account_subject: challenge().account_subject,
      target: {
        workspace_id: identity.workspace_id, session_id: identity.session_id,
        archive_token: identity.archive_token, environment_id: identity.environment_id,
        account_issuer: identity.account_issuer, account_subject: identity.account_subject,
        action: 'stage',
      },
    },
  }
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: request.method, result: { archive_phase: 'prepared' } }
  expect(decodeHostControlFrame(encodeHostControlFrame(request as never))).toEqual(request)
  expect(decodeHostControlFrame(encodeHostControlFrame(result as never))).toEqual(result)
  for (const action of [['stage'], 'unknown']) {
    expect(() => encodeHostControlFrame({ ...request,
      params: { ...request.params, target: { ...request.params.target, action } } } as never)).toThrow()
  }
  expect(() => encodeHostControlFrame({ ...request,
    params: { ...request.params, target: { ...request.params.target, archive_phase: 'archived' } } } as never)).toThrow()
  expect(() => encodeHostControlFrame({ ...result, result: { archive_phase: ['prepared'] } } as never)).toThrow()
})
