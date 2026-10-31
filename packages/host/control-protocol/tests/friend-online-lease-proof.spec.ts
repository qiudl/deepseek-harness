import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'
import { encodeHostFriendOnlineLeasePayload, parseHostFriendOnlineLeaseChallenge,
  parseHostFriendOnlineLeaseAssertion, type HostFriendOnlineLeaseChallenge } from '../src/friend-online-lease-proof.ts'

const challenge: HostFriendOnlineLeaseChallenge = {
  schema_version:1,operation:'renew',environment_id:'staging',
  authority_environment_id:'11111111-1111-4111-8111-111111111111',
  request_id:'22222222-2222-4222-8222-222222222222',owner_user_id:'owner-a',
  account_issuer:'https://accounts.example.com',
  account_subject:'33333333-3333-4333-8333-333333333333',
  profile_id:'44444444-4444-4444-8444-444444444444',profile_epoch:'2',
  identity_id:'55555555-5555-4555-8555-555555555555',identity_epoch:'3',
  binding_id:'binding-a',binding_epoch:'4',computer_id:'computer-a',
  computer_installation_id:'install-a',computer_authorization_version:'5',
  host_installation_id:'66666666-6666-4666-8666-666666666666',
  host_public_key:Buffer.alloc(32,4).toString('base64url'),
  host_instance_id:'77777777-7777-4777-8777-777777777777',
  process_nonce:Buffer.alloc(32,5).toString('base64url'),
  connection_id:'88888888-8888-4888-8888-888888888888',
  device_id:'99999999-9999-4999-8999-999999999999',key_epoch:'6',
  expected_lease_epoch:'7',issued_at:1000,expires_at:11000,
  nonce:Buffer.alloc(32,6).toString('base64url'),
}
test('friend lease proof has exact domain and operation binding',()=>{
  const signature=Buffer.alloc(64).toString('base64url')
  const payload=encodeHostFriendOnlineLeasePayload({ schema_version:1,challenge,signature })
  assert.equal(payload.subarray(0,33).toString(),'slark-dsh-friend-online-lease/v1\0')
  assert.equal(createHash('sha256').update(payload).digest('hex'),
    '801c4d4000ed80753072bc3e8161d361dfa16a00a63ca4cc329c9725fe14319f')
  assert.throws(()=>parseHostFriendOnlineLeaseChallenge({ ...challenge,operation:'issue' }),
    /invalid_friend_online_lease_proof/u)
  assert.throws(()=>parseHostFriendOnlineLeaseChallenge({ ...challenge,expected_lease_epoch:'0' }),
    /invalid_friend_online_lease_proof/u)
  assert.notDeepEqual(encodeHostFriendOnlineLeasePayload({ schema_version:1,
    challenge:{ ...challenge,connection_id:challenge.device_id },signature }),payload)
  assert.equal(parseHostFriendOnlineLeaseChallenge({ ...challenge,
    operation:'issue',expected_lease_epoch:'0' }).operation,'issue')
})

test('friend lease proof rejects malformed objects and noncanonical authority fields',()=>{
  const signature=Buffer.alloc(64).toString('base64url')
  const rejects=(value:unknown)=>{ assert.throws(()=>parseHostFriendOnlineLeaseChallenge(value),
    /invalid_friend_online_lease_proof/u) }
  rejects(null)
  rejects({ ...challenge,extra:true })
  rejects(Object.defineProperty({ ...challenge },'nonce',{ get:()=>challenge.nonce,enumerable:true }))
  for (const [key,value] of [
    ['schema_version',2],['operation','revoke'],['environment_id','UPPER'],
    ['owner_user_id','invalid user'],['account_issuer','http://accounts.example.com'],
    ['account_issuer','not a URL'],['account_issuer','x'.repeat(2049)],
    ['binding_id','bad binding'],['computer_id','bad computer'],
    ['computer_installation_id',''],['request_id','not-a-uuid'],['key_epoch','0'],
    ['host_public_key',123],['host_public_key','bad'],['process_nonce','bad'],['nonce','bad'],
    ['issued_at',-1],['expires_at',1000],['expires_at',11001],
  ] as const) rejects({ ...challenge,[key]:value })
  assert.throws(()=>parseHostFriendOnlineLeaseAssertion({ schema_version:1,challenge,
    signature:'bad' }),/invalid_friend_online_lease_proof/u)
  assert.equal(parseHostFriendOnlineLeaseAssertion({ schema_version:1,challenge,signature })
    .signature,signature)
})

test('friend lease Host control frames roundtrip and reject extra private fields',()=>{
  const request={ version:1,type:'request',request_id:challenge.request_id,
    method:'profile.friend_online_lease',params:{
      client_instance_id:challenge.request_id,host_instance_id:challenge.host_instance_id,
      process_nonce:challenge.process_nonce,jti:challenge.connection_id,
      issued_at:1000,expires_at:2000,
      authority_environment_id:challenge.authority_environment_id,
      account_binding_handle:challenge.binding_id,authority_binding_version:4,
      account_issuer:challenge.account_issuer,account_subject:challenge.account_subject,
      challenge,
    } }
  const result={ version:1,type:'result',request_id:request.request_id,
    method:request.method,result:{ schema_version:1,challenge,
      signature:Buffer.alloc(64).toString('base64url') } }
  for (const frame of [request,result]) {
    const encoded=`${JSON.stringify(frame)}\n`
    assert.equal(encodeHostControlFrame(decodeHostControlFrame(encoded)),encoded)
  }
  assert.throws(()=>decodeHostControlFrame(`${JSON.stringify({ ...request,
    params:{ ...request.params,private_key:'secret' } })}\n`))
  assert.throws(()=>decodeHostControlFrame(`${JSON.stringify({ ...result,
    result:{ ...result.result,signature:'bad' } })}\n`))
})
