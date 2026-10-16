// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SlarkAccountLauncher } from '../src/client/SlarkAccountLauncher.tsx'
import { dockRuntime, dockTranslate } from './fixture-state.client.ts'

afterEach(cleanup)
it('keeps the authenticated Slark name and avatar beside the rightmost Settings action', () => {
  const openSettings = vi.fn(), refreshAccount = vi.fn(async () => {})
  const props: Parameters<typeof SlarkAccountLauncher>[0] = { ...dockRuntime(), wide: true, settingsOpen: false,
    openSettings, openOnboarding: () => {}, refreshAccount, t: dockTranslate,
    useSlarkAccount: selector => selector({ name: 'Alice', avatarUrl: 'data:image/png;base64,AQID' }) }
  const f = render(<SlarkAccountLauncher {...props} />)
  expect(screen.getByText('Alice')).toBeTruthy()
  expect(screen.getByText('slark-profile')).toBeTruthy()
  const settings = screen.getByTestId('slark-account-settings')
  expect(screen.getByTestId('slark-account-row').lastElementChild).toBe(settings)
  fireEvent.click(settings)
  expect(openSettings).toHaveBeenCalledOnce()
  expect(refreshAccount).toHaveBeenCalledOnce()
  const image = f.container.querySelector('img')!
  act(() => { fireEvent.error(image) })
  expect(f.container.querySelector('img')).toBeNull()
  expect(screen.getByText('Alice')).toBeTruthy()
  f.rerender(<SlarkAccountLauncher {...props} wide={false} />)
  expect(screen.queryByText('Alice')).toBeNull()
  expect(screen.getByTestId('slark-account-settings')).toBeTruthy()
})
