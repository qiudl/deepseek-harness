import { afterEach, expect, test, vi } from 'vitest'
import { CollaborationResponseProjection, type ResponseSubscribe } from '../src/client/collaboration-response.ts'
import type { CollaborationResultsBridge } from '../src/client/collaboration-results.ts'
import { shareCollaborationReads } from '../src/client/collaboration-read-bridge.ts'

const source = { workspace_id: 'workspace', session_id: 'session', source_message_id: 'message', source_revision: '1' }
const original = { source, snapshot_digest: 'd'.repeat(64) }
const admission = { source, previewId: 'preview', taskId: 'task' }
const base = { source_locator: source, task_id: 'task', target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' } }
const snapshot = (text = '首段', seq = '1', extra: Record<string, unknown> = {}) => ({ ...base, kind: 'response_snapshot', schema_version: 1,
  invocation_id: 'invocation', attempt_fence: '1', seq, source_digest: original.snapshot_digest, provisional: true, text,
  text_digest: 'e'.repeat(64), emitted_at: '1', ...extra })
function fixture() {
  let current = true
  const callbacks: ((value: unknown) => void)[] = [], stops: ReturnType<typeof vi.fn>[] = []
  const changed = vi.fn(), subscribe = vi.fn((_request: unknown, callback: (value: unknown) => void) => {
    callbacks.push(callback); const stop = vi.fn(); stops.push(stop); return stop
  })
  const model = new CollaborationResponseProjection(subscribe, () => current, changed)
  return { model, changed, subscribe, callbacks, stops, revoke() { current = false } }
}
afterEach(() => vi.useRealTimers())

test('real body replaces its prefix and the original final delivery retires it without a duplicate', () => {
  const f = fixture(); f.model.admit(admission); f.callbacks[0]!(snapshot())
  expect(f.model.read(original, [])[0]?.text).toBe('首段')
  f.callbacks[0]!(snapshot('完整正文', '3')); expect(f.model.read(original, [])[0]?.text).toBe('完整正文')
  f.callbacks[0]!({ ...base, kind: 'terminal_available', invocation_id: 'invocation' })
  expect(f.changed).toHaveBeenLastCalledWith(true); expect(f.stops[0]).toHaveBeenCalledOnce()
  expect(f.model.read(original, [])).toHaveLength(1)
  expect(f.model.read(original, ['invocation'])).toEqual([])
  f.callbacks[0]!(snapshot('late', '4')); expect(f.model.read(original, [])).toEqual([])
})
test('a body attaches only to its exact Native Source snapshot and disappears on authority change', () => {
  const f = fixture(); f.model.admit(admission); f.callbacks[0]!(snapshot())
  expect(f.model.read({ ...original, snapshot_digest: 'f'.repeat(64) }, [])).toEqual([])
  expect(f.model.read({ ...original, source: { ...source, source_message_id: 'other' } }, [])).toEqual([])
  f.revoke(); f.callbacks[0]!(snapshot('late', '2')); expect(f.model.read(original, [])).toEqual([])
  expect(f.stops[0]).toHaveBeenCalledOnce(); f.model.admit(admission); expect(f.subscribe).toHaveBeenCalledOnce()
})
test('invalid Source, task, body, sequence, fence and shape never replace a verified prefix', () => {
  for (const value of [null, [], {}, snapshot('bad','2',{ source_locator:{ ...source,session_id:'other' } }),
    snapshot('bad','2',{ task_id:'other' }), snapshot('bad','2',{ schema_version:2 }), snapshot('bad','2',{ provisional:false }),
    snapshot('bad','2',{ text_digest:'broken' }), snapshot('bad','0'), snapshot('bad','2',{ attempt_fence:'2' }),
    snapshot('bad','2',{ invocation_id:'other' }), snapshot('bad','2',{ source_digest:'f'.repeat(64) }), snapshot('again'),
    snapshot('x'.repeat(128*1024+1),'2'), snapshot('\ud800','2'), snapshot('','2'),
    snapshot('bad','2',{ target_display_snapshot:{ agent_name:7,project_name:null } }), snapshot('bad','2',{ unexpected:true }),
    { ...base,kind:'terminal_available',invocation_id:'other' }, { ...base,kind:'unknown' }]) {
    const f = fixture(); f.model.admit(admission); f.callbacks[0]!(snapshot()); f.callbacks[0]!(value)
    expect(f.model.read(original, [])).toEqual([]); expect(f.stops[0]).toHaveBeenCalledOnce()
  }
})
test('closed transport clears the displayed prefix and reconnects only the same readonly task within its budget', () => {
  vi.useFakeTimers(); const f = fixture(); f.model.admit(admission); f.callbacks[0]!(snapshot())
  f.callbacks[0]!({ kind:'closed' }); expect(f.model.read(original, [])).toEqual([])
  vi.advanceTimersByTime(1000); expect(f.subscribe).toHaveBeenCalledTimes(2)
  f.callbacks[1]!(snapshot()); expect(f.model.read(original, [])).toHaveLength(1)
  f.callbacks[1]!({ kind:'closed' }); f.model.stop(); vi.advanceTimersByTime(1000); expect(f.subscribe).toHaveBeenCalledTimes(2)
  const expired = fixture(); expired.model.admit(admission); vi.advanceTimersByTime(120001)
  expired.callbacks[0]!({ kind:'closed' }); vi.advanceTimersByTime(1000); expect(expired.subscribe).toHaveBeenCalledOnce()
})
test('reconnect cannot accept a lower sequence, changed same-sequence digest or replacement fence', () => {
  vi.useFakeTimers()
  for (const extra of [{ seq:'1' },{ text_digest:'f'.repeat(64) },{ attempt_fence:'2' }]) {
    const f = fixture(); f.model.admit(admission); f.callbacks[0]!(snapshot('body','2'))
    f.callbacks[0]!({ kind:'closed' }); vi.advanceTimersByTime(1000)
    f.callbacks[1]!(snapshot('body','2',extra)); expect(f.model.read(original, [])).toEqual([]); f.model.stop()
  }
})
test('terminal without a provisional body is retired by final delivery; unavailable stops immediately', () => {
  const f = fixture(); f.model.admit(admission); f.callbacks[0]!({ ...base,kind:'terminal_available',invocation_id:'invocation' })
  expect(f.model.read(original,['invocation'])).toEqual([])
  f.model.admit(admission); expect(f.subscribe).toHaveBeenCalledTimes(2)
  f.callbacks[1]!({ ...base,kind:'unavailable' }); expect(f.model.read(original,[])).toEqual([])
})
test('admission is bounded, duplicate-safe and disposable across synchronous callback or subscriber failures', () => {
  const f = fixture(); for(const bad of [null, [], {}, { ...admission,extra:true },{ ...admission,previewId:'' },
    { ...admission,source:{ ...source,source_revision:'0' } }]) f.model.admit(bad)
  expect(f.subscribe).not.toHaveBeenCalled()
  for(let i=0;i<10;i++)f.model.admit({ ...admission,taskId:`task${i}` })
  expect(f.subscribe).toHaveBeenCalledTimes(8); f.model.admit({ ...admission,taskId:'task0' }); expect(f.subscribe).toHaveBeenCalledTimes(8)
  f.model.stop(); expect(f.stops.every(stop=>stop.mock.calls.length===1)).toBe(true)
  const stop = vi.fn(), changed=vi.fn()
  const sync = new CollaborationResponseProjection((_request,cb)=>{cb(null);return stop},()=>true,changed)
  sync.admit(admission); expect(stop).toHaveBeenCalledOnce()
  const failed = new CollaborationResponseProjection(()=>{throw Error('offline')},()=>true,changed)
  failed.admit(admission); expect(failed.read(original,[])).toEqual([])
})
test('two visible areas share one live Main stream and release it only after the final observer leaves', () => {
  let receive: ((value: unknown)=>void)|undefined, generation: unknown = {}, owner: CollaborationResultsBridge | undefined
  const stop=vi.fn(), raw=vi.fn<ResponseSubscribe>((_request,callback)=>{receive=callback;return stop})
  owner={ collaborationResponseAvailable:true,collaborationResponse:raw }
  const bridge=shareCollaborationReads(()=>owner,{ getSnapshot:()=>generation })
  const a=vi.fn(),b=vi.fn(),request={ previewId:'preview',taskId:'task' }
  const closeA=bridge()!.collaborationResponse!(request,a)
  const closeBeforeBody=bridge()!.collaborationResponse!(request,b); closeBeforeBody(); expect(b).not.toHaveBeenCalled()
  receive!(snapshot())
  const closeB=bridge()!.collaborationResponse!(request,b); expect(raw).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce()
  closeA(); expect(stop).not.toHaveBeenCalled(); closeB(); expect(stop).toHaveBeenCalledOnce()
  bridge()!.collaborationResponse!(request,a); generation={}; bridge(); expect(stop).toHaveBeenCalledTimes(2)
  owner=undefined; expect(bridge()).toBeUndefined()
})

test('shared transport handles synchronous close, failed callbacks, failed replay and late packets without retaining readers', () => {
  const request = { previewId: 'preview', taskId: 'task' }, stop = vi.fn()
  let receive: ((value: unknown) => void) | undefined
  const raw = vi.fn<ResponseSubscribe>((_request, callback) => { receive = callback; return stop })
  let owner: CollaborationResultsBridge = { collaborationResponseAvailable: true, collaborationResponse: raw }
  const bridge = shareCollaborationReads(() => owner, { getSnapshot: () => 1 })
  const a = vi.fn(), throwing = () => { throw Error('unmounted') }
  const close = bridge()!.collaborationResponse!(request, a)
  receive!({ kind: 'closed' }); receive!(snapshot())
  expect(a).toHaveBeenCalledOnce()
  close(); expect(stop).not.toHaveBeenCalled()
  bridge()!.collaborationResponse!(request, throwing); receive!(snapshot())
  expect(stop).toHaveBeenCalledOnce()
  const next = bridge()!.collaborationResponse!(request, a); receive!(snapshot())
  expect(() => bridge()!.collaborationResponse!(request, throwing)).toThrow('response_unavailable')
  next(); expect(stop).toHaveBeenCalledTimes(2)
  const synchronousStop = vi.fn()
  owner = { collaborationResponse: (_request, callback) => { callback({ kind: 'closed' }); return synchronousStop } }
  bridge()!.collaborationResponse!(request, a)
  expect(synchronousStop).toHaveBeenCalledOnce()
  owner = { collaborationResponse: () => { throw Error('offline') } }
  expect(() => bridge()!.collaborationResponse!(request, a)).toThrow('response_unavailable')
})

test('a delayed reconnect loses authority, stops its timer on final delivery and never follows a terminal closure', () => {
  vi.useFakeTimers()
  const revoked = fixture(); revoked.model.admit(admission); revoked.callbacks[0]!({ kind: 'closed' })
  revoked.revoke(); vi.advanceTimersByTime(1000); expect(revoked.subscribe).toHaveBeenCalledOnce(); revoked.model.stop()
  const delivered = fixture(); delivered.model.admit(admission); delivered.callbacks[0]!(snapshot())
  delivered.callbacks[0]!({ kind: 'closed' }); delivered.model.read(original, ['invocation'])
  vi.advanceTimersByTime(1000); expect(delivered.subscribe).toHaveBeenCalledOnce()
  const terminal = fixture(); terminal.model.admit(admission)
  terminal.callbacks[0]!({ ...base, kind: 'terminal_available', invocation_id: 'invocation' })
  terminal.callbacks[0]!({ kind: 'closed' }); vi.advanceTimersByTime(1000)
  expect(terminal.subscribe).toHaveBeenCalledOnce(); terminal.model.stop()
})
