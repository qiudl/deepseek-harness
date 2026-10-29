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

it('offers quick chat and dictation, inserting returned text at the captured original position without submitting', async () => {
  const props = dockRuntime('original')
  const span = { start: 2, end: 2, draftRev: 7 }
  props.inputActions.captureInsertion = vi.fn(() => span)
  const insertText = vi.fn(() => true); props.inputActions.insertText = insertText
  const submit = vi.fn(); props.inputActions.submit = submit
  const start = vi.fn(async () => {}), dictate = vi.fn<(id: string, signal: AbortSignal) => Promise<string | null>>(async () => '转写草稿')
  const view = render(createElement(NativeDuetButton, { ...props, t: dockTranslate, start, dictate }))
  onTestFinished(() => { view.unmount() })
  fireEvent.click(view.getByRole('button', { name: '语音输入' }))
  expect(view.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['快聊', '语音转写'])
  fireEvent.click(view.getByRole('menuitem', { name: '语音转写' }))
  await vi.waitFor(() => { expect(insertText).toHaveBeenCalledWith('转写草稿', span) })
  expect(dictate.mock.calls[0]?.[0]).toBe('original')
  expect(submit).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
})

it('keeps a transcript for copying when the draft changed, and does not insert cancelled text', async () => {
  const props = dockRuntime('original')
  props.inputActions.captureInsertion = vi.fn(() => ({ start: 0, end: 0, draftRev: 1 }))
  const insertText = vi.fn(() => false); props.inputActions.insertText = insertText
  const dictate = vi.fn<(id: string, signal: AbortSignal) => Promise<string | null>>().mockResolvedValueOnce('保留转写').mockResolvedValueOnce(null)
  const view = render(createElement(NativeDuetButton, { ...props, t: dockTranslate, dictate }))
  onTestFinished(() => { view.unmount() })
  fireEvent.click(view.getByRole('button', { name: '语音输入' })); fireEvent.click(view.getByRole('menuitem', { name: '语音转写' }))
  await vi.waitFor(() => { expect(view.getByRole('status').textContent).toContain('保留转写') })
  expect(view.getByRole('status').textContent).toContain('输入内容已变化')
  fireEvent.click(view.getByRole('button', { name: '语音输入' })); fireEvent.click(view.getByRole('menuitem', { name: '语音转写' }))
  await vi.waitFor(() => { expect(view.queryByRole('status')).toBeNull() })
  expect(insertText).toHaveBeenCalledTimes(1)
})

it('cancels the original native request and ignores late text after a Session change or Loader disposal', async () => {
  let complete!: (value: string) => void, signal!: AbortSignal
  const dictate = (_id: string, active: AbortSignal) => { signal = active; return new Promise<string>((resolve) => { complete = resolve }) }
  const first = dockRuntime('first'), second = dockRuntime('second')
  first.inputActions.captureInsertion = second.inputActions.captureInsertion = () => ({ start: 0, end: 0, draftRev: 0 })
  const insertFirst = vi.fn(() => true), insertSecond = vi.fn(() => true)
  first.inputActions.insertText = insertFirst; second.inputActions.insertText = insertSecond
  const view = render(createElement(NativeDuetButton, { ...first, t: dockTranslate, dictate }))
  onTestFinished(() => { view.unmount(); complete?.('') })
  fireEvent.click(view.getByRole('button', { name: '语音输入' })); fireEvent.click(view.getByRole('menuitem', { name: '语音转写' }))
  const firstSignal = signal
  view.rerender(createElement(NativeDuetButton, { ...second, t: dockTranslate, dictate }))
  expect(firstSignal.aborted).toBe(true); complete('旧会话迟到结果'); await Promise.resolve()
  expect(insertFirst).not.toHaveBeenCalled(); expect(insertSecond).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: '语音输入' })); fireEvent.click(view.getByRole('menuitem', { name: '语音转写' }))
  view.unmount(); expect(signal.aborted).toBe(true); complete('卸载后迟到结果'); await Promise.resolve()
  expect(insertSecond).not.toHaveBeenCalled()
})

it('supports keyboard menu navigation and displays dictation failure without starting a call', async () => {
  const props = dockRuntime(); props.inputActions.captureInsertion = () => ({ start: 0, end: 0, draftRev: 0 })
  const start = vi.fn(async () => {}), dictate = vi.fn(async () => { throw Error('busy') })
  const view = render(createElement(NativeDuetButton, { ...props, t: dockTranslate, start, dictate }))
  onTestFinished(() => { view.unmount() })
  const button = view.getByRole('button', { name: '语音输入' }); fireEvent.click(button)
  expect(document.activeElement).toBe(view.getByRole('menuitem', { name: '快聊' }))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(view.getByRole('menuitem', { name: '语音转写' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); expect(document.activeElement).toBe(button)
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(button); fireEvent.click(view.getByRole('menuitem', { name: '语音转写' }))
  await vi.waitFor(() => { expect(view.getByRole('status').textContent).toContain('转写暂不可用') })
  expect(start).not.toHaveBeenCalled()
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
