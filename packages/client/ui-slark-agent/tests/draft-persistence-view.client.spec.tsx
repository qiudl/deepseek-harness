// @vitest-environment jsdom
import { createElement } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DraftPersistence } from '../src/client/DraftPersistence.tsx'
import { dockRuntime, dockTranslate } from './fixture-state.client.ts'

it('shows Session-owned uncertainty and disables duplicate retry while saving', () => {
  const retryDraft = vi.fn(async () => {})
  const props = (sessionId: string, failed: boolean, retrying = false): Parameters<typeof DraftPersistence>[0] => ({
    ...dockRuntime(sessionId), t: dockTranslate, retryDraft,
    useDraftPersistence: selector => selector({ failed, retrying }),
  })
  const view = render(createElement(DraftPersistence, props('first', true)), { reactStrictMode: true })
  onTestFinished(() => { view.unmount() })
  expect(view.getByRole('status').textContent).toContain('无法确认草稿已保存')
  fireEvent.click(view.getByTestId('slark-draft-retry')); expect(retryDraft).toHaveBeenCalledOnce()
  view.rerender(createElement(DraftPersistence, props('first', true, true)))
  expect(view.getByTestId('slark-draft-retry')).toHaveProperty('disabled', true)
  expect(view.getByTestId('slark-draft-retry').textContent).toBe(dockTranslate('draft.retrying'))
  fireEvent.click(view.getByTestId('slark-draft-retry')); expect(retryDraft).toHaveBeenCalledOnce()
  view.rerender(createElement(DraftPersistence, props('second', false)))
  expect(view.queryByRole('status')).toBeNull()
})
