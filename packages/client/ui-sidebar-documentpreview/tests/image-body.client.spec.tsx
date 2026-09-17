// @vitest-environment jsdom
/** Image Blob ownership, media types, intrinsic rendering, and failure states. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ImageBody, imageMediaType, type ImageBodyProps } from '../src/client/image/ImageBody.tsx'
import { en } from '../src/client/image/locales.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  }
})

function props(path = 'asset.png', data: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])): ImageBodyProps {
  return {
    resourceAddress: `dsh-resource://file/session/image/${path}`,
    content: { kind: 'bytes', data },
    wrap: false,
    sessionId: 'image' as SessionId,
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
    useResource: () => ({ value: undefined }),
    t: (key, params) => {
      const value = translations.get(key) ?? key
      return params === undefined ? value : value.replace('{name}', String(params.name))
    },
  } as ImageBodyProps
}

describe('ImageBody', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['bmp', 'image/bmp'],
    ['ico', 'image/x-icon'],
    ['svg', 'image/svg+xml'],
  ] as const)('assigns .%s bytes the %s Blob media type', async (extension, mediaType) => {
    const view = render(<ImageBody {...props(`asset.${extension}`)} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(create.mock.calls[0]?.[0].type).toBe(mediaType)
    expect(image.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('keeps the image unscaled and non-draggable, then shows it after decoding succeeds', async () => {
    render(<ImageBody {...props('photo.svg')} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(image.getAttribute('alt')).toBe('Image preview: photo.svg')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(image.getAttribute('draggable')).toBe('false')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image.hasAttribute('hidden')).toBe(true)
    fireEvent.load(image)
    expect(image.hasAttribute('hidden')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('provides bounded keyboard, modifier-wheel, and reset zoom without consuming ordinary scrolling', async () => {
    render(<ImageBody {...props('photo.png')} />)
    const image = await screen.findByRole('img', { hidden: true })
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 600 },
    })
    fireEvent.load(image)
    const frame = image.closest('[data-image-preview]') as HTMLElement
    const zoomIn = screen.getByRole('button', { name: en.zoomIn })
    const zoomOut = screen.getByRole('button', { name: en.zoomOut })
    const reset = screen.getByRole('button', { name: en.resetZoom })

    fireEvent.click(zoomIn)
    expect(reset.textContent).toBe('125%')
    expect(image.getAttribute('style')).toContain('width: 1000px')
    fireEvent.keyDown(frame, { key: '=' })
    expect(reset.textContent).toBe('150%')
    fireEvent.keyDown(frame, { key: '-' })
    expect(reset.textContent).toBe('125%')
    fireEvent.keyDown(frame, { key: '0' })
    expect(reset.textContent).toBe('100%')
    const unrelated = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    fireEvent(frame, unrelated)
    expect(unrelated.defaultPrevented).toBe(false)

    const ordinaryWheel = new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true })
    fireEvent(frame, ordinaryWheel)
    expect(ordinaryWheel.defaultPrevented).toBe(false)
    fireEvent.wheel(frame, { deltaY: -1, ctrlKey: true })
    expect(reset.textContent).toBe('125%')
    fireEvent.wheel(frame, { deltaY: 1, metaKey: true })
    expect(reset.textContent).toBe('100%')
    fireEvent.click(reset)

    for (let index = 0; index < 20; index += 1) fireEvent.click(zoomOut)
    expect(reset.textContent).toBe('25%')
    expect(zoomOut.hasAttribute('disabled')).toBe(true)
    for (let index = 0; index < 20; index += 1) fireEvent.click(zoomIn)
    expect(reset.textContent).toBe('400%')
    expect(zoomIn.hasAttribute('disabled')).toBe(true)
  })

  it('revokes replaced bytes and reports image decode and Blob creation failures', async () => {
    const initial = props()
    const view = render(<ImageBody {...initial} />)
    const first = await screen.findByRole('img', { hidden: true })
    fireEvent.error(first)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
    const changed = props('asset.png', new Uint8Array([4, 5, 6]))
    view.rerender(<ImageBody {...changed} />)
    await screen.findByRole('img', { hidden: true })
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
    create.mockImplementationOnce(() => { throw new Error('Blob unavailable') })
    view.rerender(<ImageBody {...props('changed.png', new Uint8Array([7]))} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/2')
  })

  it('rejects text delivery and an unregistered suffix without creating a Blob', () => {
    const initial = props()
    const view = render(<ImageBody {...initial} content={{ kind: 'text', text: 'plain', pages: [], eof: true }} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    view.rerender(<ImageBody {...props('asset.unknown')} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(create).not.toHaveBeenCalled()
  })

  it('matches media types case-insensitively on decoded path suffixes', () => {
    expect(imageMediaType('folder/PHOTO.JPEG')).toBe('image/jpeg')
    expect(imageMediaType('folder/no-extension')).toBeUndefined()
    expect(imageMediaType('folder/photo.avif')).toBeUndefined()
  })
})
