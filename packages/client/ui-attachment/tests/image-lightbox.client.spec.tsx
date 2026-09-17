// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'

afterEach(cleanup)

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

    fireEvent.keyDown(window, { key: '+' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(view.getByRole('img').getAttribute('style')).toContain('translate(-40px, 0px)')
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
})
