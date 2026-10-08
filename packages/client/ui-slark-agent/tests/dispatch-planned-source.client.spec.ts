import { expect, it, onTestFinished, vi } from 'vitest'
import { dispatchPlannedSource } from '../src/client/dispatch-planned-source.ts'
import type { CollaborationResultsBridge } from '../src/client/collaboration-results.ts'

const source = { workspace_id: 'workspace', session_id: 'session', source_message_id: 'original', source_revision: '1' as const }
const trace = 'a'.repeat(32)
const preview = () => ({ ok: true, rootTraceId: trace, previewId: 'preview', executionEnabled: true,
  tasks: [{ taskId: 'task-a' }, { taskId: 'task-b' }] })
type Execute = NonNullable<CollaborationResultsBridge['collaborationRootExecution']>

it('dispatches distinct frozen tasks concurrently and preserves original coordinates', async () => {
  const releases: Array<(value: unknown) => void> = []
  const execute = vi.fn<Execute>(async request => request.action === 'preview' ? preview()
    : new Promise((resolve) => { releases.push(resolve) }))
  const active = dispatchPlannedSource(execute, source, trace, new AbortController().signal, () => true)
  onTestFinished(async () => { for (const release of releases) release({ ok: true, status: 'recorded' }); await active })
  await vi.waitFor(() => { expect(releases).toHaveLength(2) })
  expect(execute.mock.calls.map(([request]) => request)).toEqual([
    { action: 'preview', source }, { action: 'confirm', previewId: 'preview', taskId: 'task-a' },
    { action: 'confirm', previewId: 'preview', taskId: 'task-b' },
  ])
  for (const release of releases) release({ ok: true, status: 'recorded' })
  expect(await active).toBe('recorded')
})

it.each([null, [], false, { ok: false }, { ...preview(), rootTraceId: 'foreign' },
  { ...preview(), previewId: '' }, { ...preview(), previewId: 'x'.repeat(257) },
  { ...preview(), previewId: 'bad\n' }, { ...preview(), previewId: '\ud800' },
  { ...preview(), executionEnabled: 'true' }, { ...preview(), tasks: null },
  { ...preview(), tasks: [] }, { ...preview(), tasks: Array.from({ length: 11 }, (_, i) => ({ taskId: String(i) })) },
  { ...preview(), extra: 'x'.repeat(800 * 1024) }, { ...preview(), tasks: [null] },
  { ...preview(), tasks: [{}] }, { ...preview(), tasks: [{ taskId: 4 }] },
  { ...preview(), tasks: [{ taskId: 'same' }, { taskId: 'same' }] }])(
  'rejects an invalid or foreign preview without executing any task (%#)', async (value) => {
    const execute = vi.fn<Execute>(async () => value)
    expect(await dispatchPlannedSource(execute, source, trace, new AbortController().signal, () => true)).toBe('uncertain')
    expect(execute).toHaveBeenCalledTimes(1)
  })

it('keeps a disabled preview read-only', async () => {
  const execute = vi.fn<Execute>(async () => ({ ...preview(), executionEnabled: false }))
  expect(await dispatchPlannedSource(execute, source, trace, new AbortController().signal, () => true)).toBe('not_admitted')
  expect(execute).toHaveBeenCalledTimes(1)
})

it.each([null, [], { ok: false }, { ok: true }, { ok: true, status: 'unknown' },
  { ok: true, status: 'not_admitted' }, { ok: true, status: 'recorded' }])(
  'reports aggregate admission without retrying a confirmation (%#)', async (outcome) => {
    const execute = vi.fn<Execute>(async request => request.action === 'preview' ? preview() : outcome)
    const expected = outcome && 'status' in outcome && outcome.status === 'recorded' ? 'recorded'
      : outcome && 'status' in outcome && outcome.status === 'not_admitted' ? 'not_admitted' : 'uncertain'
    expect(await dispatchPlannedSource(execute, source, trace, new AbortController().signal, () => true)).toBe(expected)
    expect(execute).toHaveBeenCalledTimes(3)
  })

it.each(['preview-rejected', 'confirm-rejected', 'before-preview', 'after-preview', 'before-confirm', 'after-confirm', 'aborted'] as const)(
  'stops at changed authority or unknown outcome: %s', async (mode) => {
    let checks = 0
    const execute = vi.fn<Execute>(async (request) => {
      if (mode === 'preview-rejected' || (mode === 'confirm-rejected' && request.action === 'confirm')) throw Error('offline')
      return request.action === 'preview' ? preview() : { ok: true, status: 'recorded' }
    })
    const controller = new AbortController()
    if (mode === 'aborted') controller.abort()
    const current = () => {
      checks++
      return !(mode === 'before-preview' && checks === 1 || mode === 'after-preview' && checks >= 2
        || mode === 'before-confirm' && checks >= 3 || mode === 'after-confirm' && checks >= 5)
    }
    expect(await dispatchPlannedSource(execute, source, trace, controller.signal, current)).toBe('uncertain')
    expect(execute.mock.calls.filter(([request]) => request.action === 'confirm').length).toBeLessThanOrEqual(2)
  })

it.each(['preview', 'confirm'] as const)('settles cancellation while %s is unresolved without late execution', async (stage) => {
  const controller = new AbortController()
  const releases: Array<(value: unknown) => void> = []
  const execute = vi.fn<Execute>(async request => request.action === stage
    ? new Promise((resolve) => { releases.push(resolve) }) : preview())
  const active = dispatchPlannedSource(execute, source, trace, controller.signal, () => true)
  onTestFinished(async () => { for (const release of releases) release({ ok: true, status: 'recorded' }); await active })
  await vi.waitFor(() => { expect(releases.length).toBeGreaterThan(0) })
  controller.abort()
  expect(await active).toBe('uncertain')
  const calls = execute.mock.calls.length
  for (const release of releases) release(preview())
  await Promise.resolve()
  expect(execute).toHaveBeenCalledTimes(calls)
})

it('reports a partial admission separately from recorded tasks', async () => {
  const execute = vi.fn<Execute>(async request => request.action === 'preview' ? preview()
    : { ok: true, status: request.action === 'confirm' && request.taskId === 'task-a' ? 'recorded' : 'not_admitted' })
  expect(await dispatchPlannedSource(execute, source, trace, new AbortController().signal, () => true)).toBe('not_admitted')
})

it('settles a peer that synchronously cancels before returning its promise', async () => {
  const controller = new AbortController()
  const execute = vi.fn<Execute>(async () => { controller.abort(); return preview() })
  expect(await dispatchPlannedSource(execute, source, trace, controller.signal, () => true)).toBe('uncertain')
  expect(execute).toHaveBeenCalledTimes(1)
})

it('observes a peer rejection after synchronous cancellation', async () => {
  const controller = new AbortController()
  const execute = vi.fn<Execute>(async () => { controller.abort(); throw Error('offline') })
  expect(await dispatchPlannedSource(execute, source, trace, controller.signal, () => true)).toBe('uncertain')
  await new Promise(resolve => setImmediate(resolve))
  expect(execute).toHaveBeenCalledTimes(1)
})

it('projects only Source coordinates when the planning input also contains text and mentions', async () => {
  const execute = vi.fn<Execute>(async request => request.action === 'preview' ? preview() : { ok: true, status: 'recorded' })
  const input = { ...source, original_message: 'original text', active_mentions: [{ mention_id: 'mention' }] }
  expect(await dispatchPlannedSource(execute, input, trace, new AbortController().signal, () => true)).toBe('recorded')
  expect(execute.mock.calls[0]?.[0]).toEqual({ action: 'preview', source })
})
