// @vitest-environment jsdom
import { createElement } from 'react'
import { render } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DraftPersistence } from '../src/client/DraftPersistence.tsx'
import type { DraftBridge } from '../src/client/draft-persistence.ts'
import { dockRuntime, dockTranslate } from './fixture-state.client.ts'

it('keeps a pending write in its original Session when the view changes Session', async () => {
  let finishWrite!: (v: unknown) => void
  const writes: { sessionId: string; text: string }[] = []
  const bridge: DraftBridge = async (request) => {
    if (request.action === 'read') return { ok: true, value: { revision: 0, text: '' } }
    writes.push(request)
    if (request.sessionId === 'first') return new Promise((resolve) => { finishWrite = resolve })
    return { ok: true, value: { revision: 1, text: request.text } }
  }
  const props = (sessionId: string, text: string): Parameters<typeof DraftPersistence>[0] => {
    const runtime = dockRuntime(sessionId)
    return { ...runtime, bridge, t: dockTranslate, useInput: selector => selector({ ...runtime.input, draft: text }) }
  }
  const view = render(createElement(DraftPersistence, props('first', 'first text')), { reactStrictMode: true })
  onTestFinished(() => { view.unmount() })
  await vi.waitFor(() => { expect(writes).toHaveLength(1) })
  view.rerender(createElement(DraftPersistence, props('second', 'second text')))
  await vi.waitFor(() => { expect(writes).toHaveLength(2) })
  finishWrite({ ok: true, value: { revision: 1, text: 'first text' } })
  await Promise.resolve()
  expect(writes.map(({ sessionId, text }) => ({ sessionId, text }))).toEqual([
    { sessionId: 'first', text: 'first text' }, { sessionId: 'second', text: 'second text' },
  ])
})

it('shows an uncertain-save notice and clears it for the next Session', async () => {
  const bridge: DraftBridge = async request => request.sessionId === 'first' ? { ok: false }
    : { ok: true, value: { revision: 0, text: '' } }
  const props = (sessionId: string): Parameters<typeof DraftPersistence>[0] => {
    const runtime = dockRuntime(sessionId)
    return { ...runtime, bridge, t: dockTranslate, useInput: selector => selector(runtime.input) }
  }
  const view = render(createElement(DraftPersistence, props('first')))
  onTestFinished(() => { view.unmount() })
  await vi.waitFor(() => { expect(view.getByRole('status').textContent).toBe('无法确认草稿已保存，请复制本页内容后再关闭。') })
  view.rerender(createElement(DraftPersistence, props('second')))
  await vi.waitFor(() => { expect(view.queryByRole('status')).toBeNull() })
})
