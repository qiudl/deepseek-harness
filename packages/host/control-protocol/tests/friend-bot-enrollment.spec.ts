import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostFriendBotEnrollmentPayload,
  parseHostFriendBotEnrollmentAssertion } from '../src/friend-bot-enrollment.ts'

const U = '11111111-1111-4111-8111-111111111111'
const challenge = { schema_version:1 as const,operation:'register_bot' as const,
  environment_id:'staging',authority_environment_id:U,request_id:U,owner_user_id:'friend-a',
  account_issuer:'https://accounts.example.test',account_subject:U,profile_id:U,
  profile_epoch:'1',identity_id:U,identity_epoch:'1',binding_id:'friend-binding-a',
  binding_epoch:'1',computer_id:'computer-a',computer_installation_id:'install-a',
  computer_authorization_version:'1',host_installation_id:U,
  host_public_key:Buffer.alloc(32,1).toString('base64url'),host_instance_id:U,
  process_nonce:Buffer.alloc(32,2).toString('base64url'),connection_id:U,
  bot_id:'session-bot-a',issued_at:1800000000000,expires_at:1800000005000,
  nonce:Buffer.alloc(32,3).toString('base64url') }
const assertion = { schema_version:1 as const,challenge,bot_id:'session-bot-a',
  actor_ref:'deepseek-bot:session-bot-a',display_name:'My Bot',
  signature:Buffer.alloc(64).toString('base64url') }
const GOLDEN = '48abb3b8bcc1170af632f94c508b65a60327daf5d24f059078e6e4e8528726f2'
it('matches the Slark enrollment tuple and rejects untrusted public names',() => {
  const bytes = encodeHostFriendBotEnrollmentPayload(assertion)
  expect(bytes.length).toBe(714)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(GOLDEN)
  expect(Object.isFrozen(parseHostFriendBotEnrollmentAssertion(assertion))).toBe(true)
  for (const change of [
    { ...assertion,actor_ref:'deepseek-bot:other' },
    { ...assertion,display_name:' My Bot' },
    { ...assertion,display_name:'My\nBot' },
    { ...assertion,challenge:{ ...challenge,operation:'confirm_bot' } },
  ]) expect(() => encodeHostFriendBotEnrollmentPayload(change)).toThrow()
})
