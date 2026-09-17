import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelDesktopAttachmentSave, presentDesktopAttachmentSave, saveDesktopAttachment,
} from '../src/attachment-save.ts'

afterEach(() => { Reflect.deleteProperty(globalThis, '__DSH_DESKTOP_HOST__') })

describe('Desktop attachment Save As facade', () => {
  it('normalizes progress and terminal presentation across attachment surfaces', async () => {
    const presentations: unknown[] = []
    await presentDesktopAttachmentSave(async (onProgress) => {
      onProgress({ receivedBytes: 7, totalBytes: 10 })
      onProgress({ receivedBytes: 2, totalBytes: 0 })
      return 'cancelled'
    }, presentation => presentations.push(presentation))
    expect(presentations).toEqual([
      { state: 'saving', percent: null },
      { state: 'saving', percent: 70 },
      { state: 'saving', percent: 100 },
      { state: 'idle', percent: null },
    ])
  })

  it('normalizes rejected Save As operations as failed', async () => {
    const presentations: unknown[] = []
    await presentDesktopAttachmentSave(async () => {
      throw new Error('receiver closed')
    }, presentation => presentations.push(presentation))
    expect(presentations.at(-1)).toEqual({ state: 'failed', percent: null })
  })

  it('is unavailable without broadening browser download behavior', async () => {
    await expect(saveDesktopAttachment({
      sessionId: 's', refType: 'file', attachmentId: `sha256:${'a'.repeat(64)}`, name: 'a.pdf',
    })).resolves.toBe('unsupported')
  })

  it('requires the advertised feature and returns the native outcome', async () => {
    const saveAttachment = vi.fn(async () => ({ protocol: 1, ok: true, outcome: 'saved' as const }))
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', Object.freeze({
      hello: async () => ({ protocol: 1, ok: true, features: ['attachment-save-v1'] }),
      saveAttachment,
      cancelAttachmentSave: async () => ({ protocol: 1, ok: true }),
    }))
    const input = {
      sessionId: 's', refType: 'image' as const,
      attachmentId: `sha256:${'b'.repeat(64)}`, name: 'image.png',
    }
    await expect(saveDesktopAttachment(input)).resolves.toBe('saved')
    expect(saveAttachment).toHaveBeenCalledWith(input, undefined)
  })

  it('normalizes a durable display name to the Host protocol form', async () => {
    const saveAttachment = vi.fn(async () => ({ protocol: 1, ok: true, outcome: 'saved' as const }))
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', Object.freeze({
      hello: async () => ({ protocol: 1, ok: true, features: ['attachment-save-v1'] }),
      saveAttachment,
      cancelAttachmentSave: async () => ({ protocol: 1, ok: true }),
    }))
    const input = {
      sessionId: 's', refType: 'file' as const,
      attachmentId: `sha256:${'d'.repeat(64)}`, name: 'e\u0301.txt',
    }
    await expect(saveDesktopAttachment(input)).resolves.toBe('saved')
    expect(saveAttachment).toHaveBeenCalledWith({ ...input, name: 'é.txt' }, undefined)
  })

  it('forwards bounded native byte progress and unsubscribes after completion', async () => {
    const progress = vi.fn()
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', Object.freeze({
      hello: async () => ({ protocol: 1, ok: true, features: ['attachment-save-v1'] }),
      saveAttachment: async (_input: unknown, listener: (value: { receivedBytes: number; totalBytes: number }) => void) => {
        listener({ receivedBytes: 4, totalBytes: 8 })
        return { protocol: 1, ok: true, outcome: 'saved' as const }
      },
      cancelAttachmentSave: async () => ({ protocol: 1, ok: true }),
    }))
    await expect(saveDesktopAttachment({
      sessionId: 's', refType: 'file', attachmentId: `sha256:${'e'.repeat(64)}`, name: 'x',
    }, progress)).resolves.toBe('saved')
    expect(progress).toHaveBeenCalledWith({ receivedBytes: 4, totalBytes: 8 })
  })

  it('fails closed on a malformed or rejected host response', async () => {
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', Object.freeze({
      hello: async () => ({ protocol: 1, ok: true, features: ['attachment-save-v1'] }),
      saveAttachment: async () => ({ protocol: 1, ok: false }),
      cancelAttachmentSave: async () => ({ protocol: 1, ok: true }),
    }))
    await expect(saveDesktopAttachment({
      sessionId: 's', refType: 'file', attachmentId: `sha256:${'c'.repeat(64)}`, name: 'x',
    })).resolves.toBe('failed')
  })

  it('routes explicit cancellation through the same narrow host', async () => {
    const cancelAttachmentSave = vi.fn(async () => ({ protocol: 1, ok: true }))
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', Object.freeze({
      hello: async () => ({ protocol: 1, ok: true, features: ['attachment-save-v1'] }),
      saveAttachment: async () => ({ protocol: 1, ok: true, outcome: 'cancelled' }),
      cancelAttachmentSave,
    }))
    await expect(cancelDesktopAttachmentSave()).resolves.toBe(true)
    expect(cancelAttachmentSave).toHaveBeenCalledOnce()
  })
})
