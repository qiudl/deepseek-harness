import { expect, it, vi } from 'vitest'
import { shareCollaborationReads } from '../src/client/collaboration-read-bridge.ts'
import type { CollaborationResultsBridge } from '../src/client/collaboration-results.ts'

type Deliveries = NonNullable<CollaborationResultsBridge['collaborationDeliveries']>
const source = { workspace_id: 'workspace', session_id: 'session', source_message_id: 'message', source_revision: '1' }
const request = { source, limit: 50 }
const page = { ok: true as const, value: { deliveries: [] } }

it('does not reuse a rejected transport and removes completed replies immediately', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<Deliveries>>>()
  const read = vi.fn<Deliveries>().mockReturnValueOnce(gate.promise).mockResolvedValue(page)
  const host = { collaborationScopeAvailable: true, collaborationDeliveries: read }
  const shared = shareCollaborationReads(() => host, { getSnapshot: () => 1 })()!
  expect(shared.collaborationPlanningAvailable).toBe(false)
  const first = shared.collaborationDeliveries!(request), same = shared.collaborationDeliveries!({ ...request })
  expect(first).toBe(same)
  const failed = expect(first).rejects.toThrow('unavailable')
  gate.reject(Error('unavailable'))
  await failed
  expect(await shared.collaborationDeliveries!(request)).toBe(page)
  expect(await shared.collaborationDeliveries!(request)).toBe(page)
  expect(read).toHaveBeenCalledTimes(3)
})

it('keeps Sources, revisions, page cursors and limits in distinct pending reads', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<Deliveries>>>()
  const read = vi.fn<Deliveries>().mockReturnValue(gate.promise)
  const shared = shareCollaborationReads(() => ({ collaborationDeliveries: read }), { getSnapshot: () => 1 })()!
  const requests = [request, { ...request, limit: 1 }, { ...request, after_delivery_id: 'cursor' },
    ...(['workspace_id', 'session_id', 'source_message_id', 'source_revision'] as const)
      .map(key => ({ ...request, source: { ...source, [key]: 'different' } }))]
  try {
    const reads = requests.map(value => shared.collaborationDeliveries!(value))
    expect(read).toHaveBeenCalledTimes(requests.length)
    gate.resolve(page)
    await Promise.all(reads)
  } finally { gate.resolve(page) }
})

it('isolates replaced bridges and Connection generations before old reads settle', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<Deliveries>>>()
  const read = vi.fn<Deliveries>().mockReturnValue(gate.promise)
  let host: CollaborationResultsBridge | undefined = { collaborationDeliveries: read }, generation = 1
  const shared = shareCollaborationReads(() => host, { getSnapshot: () => generation })
  try {
    const first = shared()!, a = first.collaborationDeliveries!(request)
    expect(shared()).toBe(first)
    generation = 2
    const next = shared()!, b = next.collaborationDeliveries!(request)
    expect(next).not.toBe(first)
    host = { collaborationDeliveries: read }
    const replaced = shared()!, c = replaced.collaborationDeliveries!(request)
    expect(replaced).not.toBe(next)
    host = undefined
    expect(shared()).toBeUndefined()
    host = { collaborationDeliveries: read }
    const e = shared()!.collaborationDeliveries!(request)
    expect(read).toHaveBeenCalledTimes(4)
    gate.resolve(page)
    await Promise.all([a, b, c, e])
  } finally { gate.resolve(page) }
})

it('observes closed capabilities and passes commands through without sharing them', async () => {
  const root = vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>().mockResolvedValue({ ok: false })
  const host: CollaborationResultsBridge = { collaborationScopeAvailable: true, collaborationPlanningAvailable: true,
    collaborationRootExecution: root }
  const shared = shareCollaborationReads(() => host, { getSnapshot: () => 1 })()!
  expect('collaborationDeliveries' in shared).toBe(false)
  expect('collaborationPending' in shared).toBe(false)
  const command = { action: 'preview' as const, source }
  await Promise.all([shared.collaborationRootExecution!(command), shared.collaborationRootExecution!(command)])
  expect(root).toHaveBeenCalledTimes(2)
  Object.assign(host, { collaborationScopeAvailable: false, collaborationPlanningAvailable: false })
  expect(shared.collaborationScopeAvailable).toBe(false)
  expect(shared.collaborationPlanningAvailable).toBe(false)
})
