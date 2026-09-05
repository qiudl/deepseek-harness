// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalComputerControl } from '../src/client/LocalComputerControl.tsx'
import { SelectionConflictError, type LocalComputerTargets } from '../src/client/api.ts'

const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const targets: LocalComputerTargets = {
  items: [
    { grantId: FIRST, computerLabel: 'Studio Mac', workspaceAlias: 'Source', mode: 'read_write', expiresAt: '2030-01-01T00:00:00.000Z' },
    { grantId: SECOND, displayCode: 'MAC-42', workspaceAlias: 'Docs', mode: 'read_only', expiresAt: '2030-01-01T00:00:00.000Z' },
  ],
  selectedGrantId: FIRST,
  publicationVersion: 4,
  selectionRequired: false,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('LocalComputerControl', () => {
  it('ignores a stale refresh that resolves after a newer response', async () => {
    let resolveFirst: ((value: LocalComputerTargets) => void) | undefined
    const stale = new Promise<LocalComputerTargets>((resolve) => { resolveFirst = resolve })
    const newest = { ...targets, selectedGrantId: SECOND, publicationVersion: 5 }
    const listTargets = vi.fn()
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce(newest)
    render(<LocalComputerControl wide listTargets={listTargets} selectTarget={vi.fn()} reload={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '本地电脑：未选择本地电脑' }))
    await screen.findByRole('button', { name: '本地电脑：MAC-42' })
    resolveFirst?.(targets)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '本地电脑：MAC-42' })).toBeDefined()
    })
  })

  it('shows non-sensitive status and switches only after explicit confirmation', async () => {
    const listTargets = vi.fn(async () => targets)
    const selectTarget = vi.fn(async () => ({ ...targets, selectedGrantId: SECOND, publicationVersion: 5, reloadRequired: true }))
    const reload = vi.fn()
    render(<LocalComputerControl wide listTargets={listTargets} selectTarget={selectTarget} reload={reload} />)

    await screen.findByText('Studio Mac')
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：Studio Mac' }))
    fireEvent.click(screen.getByRole('radio', { name: /MAC-42/ }))
    expect(selectTarget).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }))

    await waitFor(() => { expect(selectTarget).toHaveBeenCalledWith(SECOND, 4) })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain(FIRST)
    expect(document.body.textContent).not.toContain(SECOND)
  })

  it('refreshes a CAS conflict and requires another confirmation', async () => {
    const listTargets = vi.fn(async () => targets)
    const selectTarget = vi.fn(async () => { throw new SelectionConflictError() })
    render(<LocalComputerControl wide={false} listTargets={listTargets} selectTarget={selectTarget} reload={vi.fn()} />)

    await waitFor(() => { expect(listTargets).toHaveBeenCalled() })
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：Studio Mac' }))
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }))
    expect((await screen.findByRole('status')).textContent).toBe('选择已在其他页面变化，请重新确认')
    expect(listTargets.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(selectTarget).toHaveBeenCalledTimes(1)
  })

  it('shows empty, required, and identifier-free fallback states', async () => {
    const fallback: LocalComputerTargets = {
      items: [{
        grantId: FIRST,
        workspaceAlias: 'Private',
        mode: 'read_only',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }],
      selectedGrantId: FIRST,
      publicationVersion: 0,
      selectionRequired: true,
    }
    const view = render(<LocalComputerControl wide listTargets={vi.fn(async () => fallback)} selectTarget={vi.fn()} reload={vi.fn()} />)
    await screen.findByRole('button', { name: '本地电脑：未选择本地电脑' })
    expect(screen.getByText('需选择')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：未选择本地电脑' }))
    expect(screen.getByRole('radio', { name: /本地电脑/ })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：未选择本地电脑' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    view.rerender(<LocalComputerControl
      wide
      listTargets={vi.fn(async () => ({ ...fallback, items: [], selectedGrantId: null }))}
      selectTarget={vi.fn()}
      reload={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：未选择本地电脑' }))
    await screen.findByText(/暂无已授权且在线/)
  })

  it('closes after a non-reload switch and blocks dismissal while the switch is pending', async () => {
    let resolveSelection: ((value: LocalComputerTargets & { reloadRequired: boolean }) => void) | undefined
    const pending = new Promise<LocalComputerTargets & { reloadRequired: boolean }>((resolve) => {
      resolveSelection = resolve
    })
    const view = render(<LocalComputerControl
      wide
      listTargets={vi.fn(async () => targets)}
      selectTarget={vi.fn(() => pending)}
      reload={vi.fn()}
    />)
    await screen.findByText('Studio Mac')
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：Studio Mac' }))
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }))
    await screen.findByText('切换中…')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('dialog')).toBeDefined()
    view.unmount()
    resolveSelection?.({ ...targets, reloadRequired: false })
    await act(async () => { await pending })

    render(<LocalComputerControl
      wide
      listTargets={vi.fn(async () => targets)}
      selectTarget={vi.fn(async () => ({ ...targets, reloadRequired: false }))}
      reload={vi.fn()}
    />)
    await screen.findByText('Studio Mac')
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：Studio Mac' }))
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('reports target-list and selection failures without exposing their details', async () => {
    const failingList = vi.fn(async (): Promise<LocalComputerTargets> => { throw new Error('secret') })
    const view = render(<LocalComputerControl wide listTargets={failingList} selectTarget={vi.fn()} reload={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：未选择本地电脑' }))
    expect((await screen.findByRole('status')).textContent).toBe('暂时无法读取本地电脑状态')
    view.unmount()

    render(<LocalComputerControl
      wide
      listTargets={vi.fn(async () => targets)}
      selectTarget={vi.fn(async () => { throw new Error('secret') })}
      reload={vi.fn()}
    />)
    await screen.findByText('Studio Mac')
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：Studio Mac' }))
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }))
    expect((await screen.findByRole('status')).textContent).toBe('切换失败，请稍后重试')
  })

  it.each([
    ['conflict', new SelectionConflictError()],
    ['generic failure', new Error('secret')],
  ])('drops a pending %s after unmount', async (_name, failure) => {
    let rejectSelection: ((reason: unknown) => void) | undefined
    const pending = new Promise<never>((_resolve, reject) => { rejectSelection = reject })
    const view = render(<LocalComputerControl
      wide
      listTargets={vi.fn(async () => targets)}
      selectTarget={vi.fn(() => pending)}
      reload={vi.fn()}
    />)
    await screen.findByText('Studio Mac')
    fireEvent.click(screen.getByRole('button', { name: '本地电脑：Studio Mac' }))
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }))
    await screen.findByText('切换中…')
    view.unmount()
    rejectSelection?.(failure)
    await act(async () => { await pending.catch(() => undefined) })
  })

  it('refreshes on focus and on the bounded polling interval', async () => {
    vi.useFakeTimers()
    const listTargets = vi.fn(async () => targets)
    render(<LocalComputerControl wide listTargets={listTargets} selectTarget={vi.fn()} reload={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    expect(listTargets).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(listTargets).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(15_000)
      await Promise.resolve()
    })
    expect(listTargets).toHaveBeenCalledTimes(3)
  })
})
