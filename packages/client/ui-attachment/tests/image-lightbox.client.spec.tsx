// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, '__DSH_DESKTOP_HOST__')
})

const labels = {
  dialog: '原图预览', close: '关闭原图预览',
  zoomOut: '缩小图片', zoomIn: '放大图片', resetZoom: '恢复适应窗口',
  save: '另存附件', saving: '正在保存…', saved: '附件已保存', saveFailed: '保存失败，请重试',
  cancelSave: '取消保存',
}

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('zooms from controls, wheel, and keyboard within the 25–400% bounds', () => {
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
    const image = view.getByRole('img')
    const zoomIn = view.getByRole('button', { name: '放大图片' })
    const zoomOut = view.getByRole('button', { name: '缩小图片' })
    const reset = view.getByRole('button', { name: '恢复适应窗口' })

    fireEvent.click(zoomIn)
    expect(reset.textContent).toBe('125%')
    expect(image.getAttribute('style')).toContain('scale(1.25)')
    fireEvent.keyDown(window, { key: '-' })
    expect(reset.textContent).toBe('100%')
    fireEvent.wheel(image.parentElement as HTMLElement, { deltaY: 1 })
    expect(reset.textContent).toBe('75%')
    for (let index = 0; index < 4; index += 1) fireEvent.click(zoomOut)
    expect(reset.textContent).toBe('25%')
    expect(zoomOut.hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(window, { key: '0' })
    expect(reset.textContent).toBe('100%')
  })

  it('traps focus among its controls and supports keyboard panning after zoom', () => {
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(view.getByRole('button', { name: '缩小图片' }))
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)

    const zoomOut = view.getByRole('button', { name: '缩小图片' })
    const reset = view.getByRole('button', { name: '恢复适应窗口' })
    zoomOut.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(reset)
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(zoomOut)

    fireEvent.keyDown(window, { key: '+' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(view.getByRole('img').getAttribute('style')).toContain('translate(-40px, 0px)')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(view.getByRole('img').getAttribute('style')).toContain('translate(0px, 0px)')
  })

  it('handles empty and externally blurred focus traps without escaping the dialog', () => {
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
    const dialog = view.getByRole('dialog')
    for (const button of view.getAllByRole('button')) button.remove()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(dialog.isConnected).toBe(true)
    view.unmount()

    const blurred = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(blurred.getByRole('button', { name: '缩小图片' }))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(blurred.getByRole('button', { name: '关闭原图预览' }))
  })

  it('supports wheel zoom, pointer panning, pinch zoom, and pointer cleanup', () => {
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
    const image = view.getByRole('img')
    const viewport = image.parentElement as HTMLElement
    const capture = vi.fn()
    Object.defineProperty(viewport, 'setPointerCapture', { configurable: true, value: capture })

    fireEvent.pointerDown(viewport, { pointerId: 4, clientX: 1, clientY: 1 })
    fireEvent.pointerMove(viewport, { pointerId: 4, clientX: 2, clientY: 2 })
    fireEvent.pointerUp(viewport, { pointerId: 4 })
    fireEvent.wheel(viewport, { deltaY: -1 })
    expect(image.getAttribute('style')).toContain('scale(1.25)')
    fireEvent.pointerMove(viewport, { pointerId: 99, clientX: 5, clientY: 5 })
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 30, clientY: 40 })
    expect(image.getAttribute('style')).toContain('translate(20px, 30px)')
    fireEvent.pointerUp(viewport, { pointerId: 1 })

    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 0, clientY: 0 })
    fireEvent.pointerDown(viewport, { pointerId: 3, clientX: 3, clientY: 4 })
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 6, clientY: 8 })
    expect(image.getAttribute('style')).toContain('scale(2.5)')
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 0, clientY: 0 })
    fireEvent.pointerCancel(viewport, { pointerId: 2 })
    fireEvent.pointerUp(viewport, { pointerId: 3 })
    expect(capture).toHaveBeenCalledTimes(4)

    fireEvent.click(view.getByRole('button', { name: '恢复适应窗口' }))
    expect(image.getAttribute('style')).toContain('translate(0px, 0px) scale(1)')
  })

  it('shows identity-bound native save progress and then completion', async () => {
    let finish!: (outcome: 'saved') => void
    const onSave = vi.fn((onProgress: (value: { receivedBytes: number; totalBytes: number }) => void) => {
      onProgress({ receivedBytes: 5, totalBytes: 10 })
      return new Promise<'saved'>((resolve) => { finish = resolve })
    })
    const view = render(
      <ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} onSave={onSave} />,
    )
    fireEvent.click(view.getByRole('button', { name: '另存附件' }))
    expect(view.getByText('正在保存… 50%')).toBeTruthy()
    expect(view.getByRole('button', { name: '取消保存' })).toBeTruthy()
    await act(async () => { finish('saved') })
    expect(view.getByText('附件已保存')).toBeTruthy()
  })

  it('shows no-percent saving and failure states', async () => {
    let finish!: (outcome: 'failed') => void
    const onSave = vi.fn(() => new Promise<'failed'>((resolve) => { finish = resolve }))
    const view = render(
      <ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} onSave={onSave} />,
    )
    fireEvent.click(view.getByRole('button', { name: '另存附件' }))
    expect(view.getByText('正在保存…')).toBeTruthy()
    await act(async () => { finish('failed') })
    expect(view.getByText('保存失败，请重试')).toBeTruthy()
  })

  it('routes a second save-button press to native cancellation', async () => {
    const cancelAttachmentSave = vi.fn(async () => ({ protocol: 1, ok: true }))
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      hello: vi.fn(), saveAttachment: vi.fn(), cancelAttachmentSave,
    })
    const onSave = vi.fn(() => new Promise<'cancelled'>(() => {}))
    const view = render(
      <ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} onSave={onSave} />,
    )
    fireEvent.click(view.getByRole('button', { name: '另存附件' }))
    fireEvent.click(view.getByRole('button', { name: '取消保存' }))
    await act(async () => {})
    expect(cancelAttachmentSave).toHaveBeenCalledOnce()
  })
})
