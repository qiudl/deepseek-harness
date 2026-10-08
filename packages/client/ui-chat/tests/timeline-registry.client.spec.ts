import { expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatTimelineRegistry, type ChatTimelineRecord } from '../src/client/timeline.ts'

const record: ChatTimelineRecord = { recordId: 'original', afterSequence: 4, localOrder: '1' }

it('observes only viewed records, retains source identity and republishes on resume and late registration', () => {
  const registry = new ChatTimelineRegistry(), id = SessionId('session')
  const value = createSnapshotStore<readonly ChatTimelineRecord[]>([record]), stop = vi.fn()
  const subscribe = vi.fn((listener: () => void) => { const off = value.subscribe(listener); return () => { off(); stop() } })
  const source: ObservableSnapshot<readonly ChatTimelineRecord[]> = {
    getSnapshot: () => value.getSnapshot(),
    subscribe,
  }
  const view = registry.source(id), changed = vi.fn(), remove = registry.register(id, source)
  expect(registry.source(id)).toBe(view)
  expect(view.getSnapshot()).toBe(value.getSnapshot())
  expect(subscribe).not.toHaveBeenCalled()
  const off = view.subscribe(changed), otherOff = view.subscribe(changed)
  expect(subscribe).toHaveBeenCalledOnce()
  value.set([])
  expect(view.getSnapshot()).toEqual([])
  off(); off(); expect(stop).not.toHaveBeenCalled()
  otherOff(); expect(stop).toHaveBeenCalledOnce()
  value.set([record])
  expect(view.getSnapshot()).toEqual([])
  const resume = view.subscribe(changed)
  expect(view.getSnapshot()).toEqual([record])
  remove(); remove()
  expect(view.getSnapshot()).toEqual([])
  expect(stop).toHaveBeenCalledTimes(2)
  expect(changed).toHaveBeenCalled()
  const replacement = registry.register(id, source)
  remove()
  expect(view.getSnapshot()).toEqual([record])
  replacement(); resume(); registry.dispose()
})

it('keeps Session sources isolated, rejects duplicate owners and contains disposed callbacks', () => {
  const registry = new ChatTimelineRegistry(), id = SessionId('session'), changed = vi.fn()
  const source = createSnapshotStore<readonly ChatTimelineRecord[]>([record])
  const callbacks: (() => void)[] = [], stop = vi.fn()
  const first = registry.source(id), second = registry.source(SessionId('other'))
  const off = first.subscribe(changed)
  const remove = registry.register(id, {
    getSnapshot: () => source.getSnapshot(), subscribe: (listener) => { callbacks.push(listener); return stop },
  })
  expect(() => registry.register(id, source)).toThrow('chat_timeline_already_registered')
  expect(first.getSnapshot()).toEqual([record]); expect(second.getSnapshot()).toEqual([])
  remove(); source.set([{ ...record, recordId: 'late' }]); callbacks[0]!()
  expect(first.getSnapshot()).toEqual([])
  const removeAfterClose = registry.register(id, source)
  registry.dispose(); registry.dispose(); callbacks[0]!()
  removeAfterClose()
  expect(first.getSnapshot()).toEqual([])
  expect(stop).toHaveBeenCalledOnce()
  expect(() => registry.register(id, source)).toThrow('chat_timeline_closed')
  const closedOff = first.subscribe(changed)
  closedOff(); off()
})
