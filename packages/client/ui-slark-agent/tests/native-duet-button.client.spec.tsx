// @vitest-environment jsdom
import { createElement } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NativeDuetButton } from '../src/client/NativeDuetButton.tsx'
import { dockRuntime, dockTranslate } from './fixture-state.client.ts'

it('starts the selected Session once from a small input action', async () => {
  let complete!: () => void
  const start = vi.fn<(sessionId: string) => Promise<void>>(() => new Promise((resolve) => { complete = resolve }))
  const view = render(createElement(NativeDuetButton, { ...dockRuntime('session-a'), t: dockTranslate, start }))
  onTestFinished(() => { view.unmount() })
  const button = view.getByRole('button', { name: 'Duet 语音对话' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(start).toHaveBeenCalledExactlyOnceWith('session-a')
  expect(button).toHaveProperty('disabled', true)
  complete()
  await vi.waitFor(() => { expect(button).toHaveProperty('disabled', false) })
})
it('shows localized failure and ignores a late failure after changing Sessions', async () => {
  let fail!: (error: Error) => void
  const start = () => new Promise<void>((_resolve, reject) => { fail = reject })
  const props = (session: string) => ({ ...dockRuntime(session), t: dockTranslate, start })
  const view = render(createElement(NativeDuetButton, props('session-a')))
  onTestFinished(() => { view.unmount() })
  fireEvent.click(view.getByRole('button'))
  view.rerender(createElement(NativeDuetButton, props('session-b')))
  fail(Error('late'))
  await Promise.resolve()
  expect(view.queryByRole('status')).toBeNull()
  fireEvent.click(view.getByRole('button')); fail(Error('unavailable'))
  await vi.waitFor(() => { expect(view.getByRole('status').textContent).toBe('暂未确认通话连接，请查看悬浮通话状态。') })
})
