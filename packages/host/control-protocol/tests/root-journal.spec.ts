import { expect, it } from 'vitest'
import * as rootProtocol from '../src/root-authority.ts'
import { readFileSync } from 'node:fs'
const proof = rootProtocol.parseHostRootAuthorityAssertion(
  (JSON.parse(readFileSync(new URL('./fixtures/root-authority-v1.json', import.meta.url), 'utf8')) as { assertion:unknown }).assertion,
)
const c = proof.challenge, s = c.source_challenge
const target = { namespace_id:c.namespace_id, command_id:c.command_id, workspace_id:s.workspace_id,
  session_id:s.session_id, source_message_id:s.source_message_id, source_revision:s.source_revision }
const receipt = { root_task_id:c.root_task_id,root_trace_id:c.root_trace_id,admission_id:c.command_id,task_revision:1,state_version:1,state:'active' }
const metadata = { schema_version:1,namespace_id:c.namespace_id,command_id:c.command_id,
  root_task_id:c.root_task_id,root_trace_id:c.root_trace_id,
  payload_digest:c.payload_digest,source_digest:s.snapshot_digest,source_descriptor:{ workspace_id:s.workspace_id,session_id:s.session_id,source_message_id:s.source_message_id,source_revision:s.source_revision,snapshot_digest:s.snapshot_digest },objective_ref:'source-v1:a',task_grant_ref:'intent-v1:a',continuation_policy:'follow_authorized_plan',state:'pending' }
it('reads pending metadata and accepts only an exact original-root receipt', () => {
  expect(rootProtocol.parseHostRootJournalCommand({ action:'read',target })).toEqual({ action:'read',target })
  expect(rootProtocol.parseHostRootJournalCommand({ action:'accept',target,receipt })).toEqual({ action:'accept',target,receipt })
  expect(rootProtocol.parseHostRootJournalMetadata(metadata)).toEqual(metadata)
  expect(rootProtocol.parseHostRootJournalMetadata({ ...metadata,state:'admitted',receipt })).toEqual({ ...metadata,state:'admitted',receipt })
  for(const bad of [{ ...metadata,source:{} },{ ...metadata,receipt },{ ...metadata,state:'admitted',receipt:{ ...receipt,admission_id:s.request_id } },{ ...metadata,source_digest:'0'.repeat(64) }]) expect(()=>rootProtocol.parseHostRootJournalMetadata(bad)).toThrow()
  for(const bad of [null, { action:'capture',target },{ action:'read',target,receipt },{ action:'accept',target,receipt:{ ...receipt,task_revision:2 } }, { action:'accept',target,receipt:{ ...receipt,admission_id:s.request_id } }]) expect(()=>rootProtocol.parseHostRootJournalCommand(bad)).toThrow()
  expect(() => rootProtocol.parseHostRootJournalMetadata(null)).toThrow()
})
it('roundtrips journal control frames and rejects unexpected metadata',async()=>{
  const { encodeHostControlFrame,decodeHostControlFrame }=await import('../src/index.ts')
  const request={ version:1,type:'request',request_id:s.request_id,method:'profile.root_journal',params:{ client_instance_id:s.request_id,host_instance_id:proof.host_instance_id,process_nonce:proof.process_nonce,jti:s.workspace_id,issued_at:1000,expires_at:2000,authority_environment_id:s.environment_id,account_binding_handle:'binding:test',authority_binding_version:1,account_issuer:s.account_issuer,account_subject:s.account_subject,command:{ action:'read',target } } }
  const result={ version:1,type:'result',request_id:s.request_id,method:request.method,result:metadata }
  for(const frame of [request,result]) expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  expect(()=>encodeHostControlFrame({ ...result,result:{ ...metadata,source:{} } } as never)).toThrow()
})

it('root analysis frames cannot downgrade to Source-only preparation or change its Source binding', async () => {
  const { parseHostCollaborationAnalysisCommand,parseHostCollaborationAnalysisResult }=await import('../src/index.ts')
  const input={ namespace_id:c.namespace_id,continuation_policy:'follow_authorized_plan',source:{ text:'original' } }
  expect(parseHostCollaborationAnalysisCommand({ action:'prepare_root',input })).toEqual({ action:'prepare_root',input })
  expect(()=>parseHostCollaborationAnalysisCommand({ action:'prepare_root',input:{ ...input,root_trace_id:c.root_trace_id } })).toThrow()
  for (const change of [{ continuation_policy: 'auto' }, { source: { text: 'x'.repeat(16384), more: 'y'.repeat(16384) } }])
    expect(() => rootProtocol.parseHostRootAnalysisInput({ ...input, ...change })).toThrow('invalid_root_authority')
  const root={ namespace_id:c.namespace_id,command_id:c.command_id,root_task_id:c.root_task_id,
    root_trace_id:c.root_trace_id,
    payload_digest:c.payload_digest,source_descriptor:metadata.source_descriptor }
  const preparation={ kind:'recovered',descriptor:metadata.source_descriptor,root }
  expect(parseHostCollaborationAnalysisResult({ kind:'root_prepared',preparation })).toEqual({ kind:'root_prepared',preparation })
  expect(()=>parseHostCollaborationAnalysisResult({ kind:'prepared',preparation })).toThrow()
  expect(()=>parseHostCollaborationAnalysisResult({ kind:'root_prepared',preparation:{ ...preparation,root:{ ...root,source_descriptor:{ ...metadata.source_descriptor,source_revision:'2' } } } })).toThrow()
})

it('saved output retains expired evidence with bounded frames and rejects altered bytes or root coordinates', async () => {
  const { createHash } = await import('node:crypto')
  const { parseHostRootAnalysisOutput, matchHostRootAnalysisOutput, encodeHostControlFrame, decodeHostControlFrame, parseHostCollaborationAnalysisCommand } = await import('../src/index.ts')
  const savedRoot = { namespace_id:c.namespace_id,command_id:c.command_id,
    root_task_id:c.root_task_id,root_trace_id:c.root_trace_id,
    payload_digest:c.payload_digest,source_descriptor:metadata.source_descriptor }
  const json = JSON.stringify({ value:'x'.repeat(32756) })
  expect(Buffer.byteLength(json)).toBe(32768)
  const evidence = { state:'saved',root:savedRoot,dispatch:{ attempt_request_id:s.request_id,plan_id:'plan',attempt_id:'attempt',expected_plan_revision:'1',attempt_fence:'1',input_manifest_digest:'a'.repeat(64),source_digest:s.snapshot_digest,lease_expires_at:'2020-01-01T00:00:00.000Z',dispatch_granted:true },output_digest:createHash('sha256').update(json).digest('hex'),json_base64url:Buffer.from(json).toString('base64url') }
  expect(parseHostCollaborationAnalysisCommand({ action:'read_root_output',target })).toEqual({ action:'read_root_output',target })
  expect(matchHostRootAnalysisOutput(evidence,target)).toEqual(evidence)
  const frame = { version:1,type:'result',request_id:s.request_id,method:'profile.collaboration_analysis',result:{ kind:'root_output',evidence } }
  const encoded = encodeHostControlFrame(frame as never)
  expect(Buffer.byteLength(encoded)).toBeLessThan(65536)
  expect(decodeHostControlFrame(encoded)).toEqual(frame)
  const signed = { ...evidence, analysis_receipt: { schema_version: 1,
    authority_environment_id: s.environment_id, account_binding_handle: 'binding:test', authority_binding_version: 1,
    account_issuer: s.account_issuer, account_subject: s.account_subject,
    installation_id: proof.installation_id, installation_public_key: proof.installation_public_key,
    host_instance_id: proof.host_instance_id, process_nonce: proof.process_nonce,
    dispatch: evidence.dispatch, output_digest: evidence.output_digest, signature: 'A'.repeat(86) } }
  const signedFrame = { ...frame, result: { kind: 'root_output', evidence: signed } }
  const signedEncoded = encodeHostControlFrame(signedFrame as never)
  expect(Buffer.byteLength(signedEncoded)).toBeLessThan(65536)
  expect(decodeHostControlFrame(signedEncoded)).toEqual(signedFrame)
  expect(parseHostRootAnalysisOutput({ state:'missing',root:savedRoot })).toEqual({ state:'missing',root:savedRoot })
  for(const bad of [{ ...evidence,output_digest:'0'.repeat(64) },{ ...evidence,json_base64url:Buffer.from(JSON.stringify({ value:'x'.repeat(32757) })).toString('base64url') },{ ...evidence,dispatch:{ ...evidence.dispatch,source_digest:'0'.repeat(64) } },{ ...evidence,manifest_json:'private' },{ ...evidence,state:'unknown' }]) expect(()=>parseHostRootAnalysisOutput(bad)).toThrow()
  expect(()=>matchHostRootAnalysisOutput(evidence,
    rootProtocol.parseHostRootSubmissionTarget({ ...target,command_id:s.request_id }))).toThrow()
  for (const bad of [null, { ...evidence, [Symbol('extra')]: true },
    ...[{ plan_id: false }, { attempt_id: '' }, { expected_plan_revision: '9223372036854775808' }].map(p => ({ ...evidence, dispatch: { ...evidence.dispatch, ...p } }))])
    expect(() => parseHostRootAnalysisOutput(bad)).toThrow()
})
