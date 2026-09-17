import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_EXPORT_ACTION,
  ATTACHMENT_EXPORT_ACTION_HEADER,
  ATTACHMENT_EXPORT_PATH,
  installAttachmentExport,
  referencedAttachment,
} from '../src/attachment-export.ts'

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'1'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  name: 'photo.png',
}

const fileRef: FileAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'2'.repeat(64)}`),
  name: 'notes.txt',
  bytes: 2,
}

async function mounted() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const readImage = vi.fn(async () => ({ ref: imageRef, data: Uint8Array.of(1, 2, 3) }))
  const readFileStream = vi.fn(async function* () {
    yield Uint8Array.of(4)
    yield Uint8Array.of(5)
  })
  ctx.provide('attachments', { readImage, readFileStream } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
  const observeSession = vi.fn(async () => ({
    header: session.header,
    inheritedEventCount: session.inheritedEventCount,
    events: session.snapshotEvents(),
    [Symbol.dispose]() {},
  }))
  ctx.provide('sessionQuery', { observeSession } as never)
  installAttachmentExport(ctx)
  session.append('user/message', createUserMessage({
    content: [
      { type: 'image', attachment: imageRef },
      { type: 'file', attachment: fileRef },
    ],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return {
    ctx,
    session,
    readImage,
    readFileStream,
    observeSession,
    fetch: (request: Request) => connection.createSharedFetchHandler('/api').fetch(request),
  }
}

function request(
  sessionId: string,
  attachmentId: string,
  refType: 'image' | 'file',
  name = refType === 'image' ? 'photo.png' : 'notes.txt',
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers)
  headers.set(ATTACHMENT_EXPORT_ACTION_HEADER, ATTACHMENT_EXPORT_ACTION)
  return new Request(
    `http://host${ATTACHMENT_EXPORT_PATH}?sessionId=${sessionId}&attachmentId=${attachmentId}&refType=${refType}&nameB64=${Buffer.from(name).toString('base64url')}`,
    {
      ...init,
      headers,
    },
  )
}

describe('Desktop attachment export route', () => {
  it('pins the cross-repository protocol fixture and route constants', async () => {
    const bytes = await readFile(new URL('../protocol/dsh-host-actions-v1.schema.json', import.meta.url))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'a44da29cc034d83689926e6711c0a170c70b44bcd323e084349b0611d3dcc799',
    )
    const schema = JSON.parse(bytes.toString('utf8')) as {
      properties: { attachmentExport: { properties: Record<string, { const: unknown }> } }
    }
    const properties = schema.properties.attachmentExport.properties
    expect(properties.path?.const).toBe(ATTACHMENT_EXPORT_PATH)
    expect(properties.actionHeader?.const).toBe(ATTACHMENT_EXPORT_ACTION_HEADER)
    expect(properties.actionValue?.const).toBe(ATTACHMENT_EXPORT_ACTION)
  })

  it('rejects renderer-reachable requests before disclosing query validity', async () => {
    const { ctx, fetch } = await mounted()
    const missingHeader = await fetch(new Request(`http://host${ATTACHMENT_EXPORT_PATH}`))
    expect(missingHeader.status).toBe(403)
    expect(await missingHeader.text()).toBe('forbidden')
    await ctx.fiber.dispose()
  })

  it('authorizes an exact logged image for HEAD and GET', async () => {
    const { ctx, session, fetch, readImage } = await mounted()
    const head = await fetch(request(
      String(session.id), String(imageRef.attachmentId), 'image', 'photo.png', { method: 'HEAD' },
    ))
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(head.headers.get('content-type')).toBe('image/png')
    expect(head.headers.get('content-length')).toBe('3')
    expect(head.headers.get('cache-control')).toBe('private, no-store')
    expect(head.headers.get('x-content-type-options')).toBe('nosniff')
    expect(head.headers.get('x-dsh-attachment-id')).toBe(String(imageRef.attachmentId))
    expect(head.headers.get('x-dsh-attachment-name-b64')).toBe(
      Buffer.from('photo.png').toString('base64url'),
    )
    expect(readImage).not.toHaveBeenCalled()

    const get = await fetch(request(String(session.id), String(imageRef.attachmentId), 'image'))
    expect(get.status).toBe(200)
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([1, 2, 3])
    expect(readImage).toHaveBeenCalledWith(imageRef, expect.any(AbortSignal))
    await ctx.fiber.dispose()
  })

  it('streams an exact logged file and refuses mismatched or unknown references', async () => {
    const { ctx, session, fetch, readFileStream } = await mounted()
    const get = await fetch(request(String(session.id), String(fileRef.attachmentId), 'file'))
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('text/plain')
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([4, 5])
    expect(readFileStream).toHaveBeenCalledWith(fileRef, expect.any(AbortSignal))

    expect((await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'image',
    ))).status).toBe(404)
    expect((await fetch(request(
      String(session.id), `sha256:${'3'.repeat(64)}`, 'file',
    ))).status).toBe(404)
    await ctx.fiber.dispose()
  })

  it('updates the live authorization index when a later event adds a reference', async () => {
    const { ctx, session, fetch } = await mounted()
    expect((await fetch(request(
      String(session.id), `sha256:${'3'.repeat(64)}`, 'file',
    ))).status).toBe(404)
    const later: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'3'.repeat(64)}`),
      name: 'later.bin',
      bytes: 2,
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'file', attachment: later }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect((await fetch(request(
      String(session.id), String(later.attachmentId), 'file', 'later.bin', { method: 'HEAD' },
    ))).status).toBe(200)
    await ctx.fiber.dispose()
  })

  it('binds authorization to the exact logged name when a digest has aliases', async () => {
    const { ctx, session, fetch } = await mounted()
    const alias: FileAttachmentRef = { ...fileRef, name: 'renamed.txt' }
    session.append('user/message', createUserMessage({
      content: [{ type: 'file', attachment: alias }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const original = await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'file', 'notes.txt', { method: 'HEAD' },
    ))
    expect(original.status).toBe(200)
    expect(original.headers.get('x-dsh-attachment-name-b64')).toBe(
      Buffer.from('notes.txt').toString('base64url'),
    )
    const renamed = await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'file', 'renamed.txt', { method: 'HEAD' },
    ))
    expect(renamed.status).toBe(200)
    expect(renamed.headers.get('x-dsh-attachment-name-b64')).toBe(
      Buffer.from('renamed.txt').toString('base64url'),
    )
    expect((await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'file', 'forged.txt', { method: 'HEAD' },
    ))).status).toBe(404)
    await ctx.fiber.dispose()
  })

  it('does not authorize attachment-shaped data from an unknown event', async () => {
    const { ctx, session, fetch } = await mounted()
    const forged = {
      attachmentId: AttachmentId(`sha256:${'4'.repeat(64)}`),
      name: 'forged.bin',
      bytes: 2,
    }
    ;(session.append as unknown as (type: string, data: unknown) => void)('extension/record', {
      content: [{ type: 'file', attachment: forged }],
    })
    expect((await fetch(request(
      String(session.id), String(forged.attachmentId), 'file', 'forged.bin', { method: 'HEAD' },
    ))).status).toBe(404)
    await ctx.fiber.dispose()
  })

  it('fails closed for cyclic and over-deep nested tool results', () => {
    const cyclic: unknown[] = []
    cyclic.push({ type: 'tool-result', content: cyclic })
    expect(referencedAttachment(
      [{ type: 'user/message', data: { content: cyclic } } as never],
      'file',
      String(fileRef.attachmentId),
      fileRef.name,
    )).toBeUndefined()

    let nested: unknown[] = [{ type: 'file', attachment: fileRef }]
    for (let depth = 0; depth < 34; depth += 1) {
      nested = [{ type: 'tool-result', content: nested }]
    }
    expect(referencedAttachment(
      [{ type: 'user/message', data: { content: nested } } as never],
      'file',
      String(fileRef.attachmentId),
      fileRef.name,
    )).toBeUndefined()
  })

  it('fails closed when one event aggregates too many attachment references', () => {
    const inserted = Array.from({ length: 4097 }, () => ({
      content: [{ type: 'file', attachment: fileRef }],
    }))
    expect(referencedAttachment(
      [{ type: 'agent/inbox/spliced', data: { inserted } } as never],
      'file',
      String(fileRef.attachmentId),
      fileRef.name,
    )).toBeUndefined()
  })

  it('recognizes every authoritative event carrier and ignores malformed carrier data', () => {
    const stream = [{
      type: 'chunk', time: 1,
      chunk: { type: 'block-end', index: 0, block: { type: 'file', attachment: fileRef } },
    }]
    const carriers = [
      { type: 'tool/result', data: { message: { content: [{ type: 'file', attachment: fileRef }] } } },
      { type: 'agent/inbox/spliced', data: { inserted: [null, { content: [{ type: 'file', attachment: fileRef }] }] } },
      { type: 'assistant/message', data: { message: { content: [] }, stream } },
      { type: 'assistant/attempt', data: { stream } },
    ]
    for (const event of carriers) {
      expect(referencedAttachment(
        [event as never], 'file', String(fileRef.attachmentId), fileRef.name,
      )).toEqual({ refType: 'file', ref: fileRef })
    }
    for (const event of [
      { type: 'user/message', data: null },
      { type: 'tool/result', data: { message: {} } },
      { type: 'agent/inbox/spliced', data: { inserted: null } },
      { type: 'assistant/attempt', data: { stream: {} } },
    ]) {
      expect(referencedAttachment(
        [event as never], 'file', String(fileRef.attachmentId), fileRef.name,
      )).toBeUndefined()
    }
  })

  it('fails closed for primitive, oversized, and excessively scanned content', () => {
    const cases = [
      { type: 'user/message', data: { content: 'not-an-array' } },
      { type: 'user/message', data: { content: [null, false, 3, 'text'] } },
      { type: 'user/message', data: { content: Array.from({ length: 100_001 }, () => null) } },
      {
        type: 'user/message',
        data: { content: Array.from({ length: 4097 }, () => ({ type: 'file', attachment: fileRef })) },
      },
    ]
    for (const event of cases) {
      expect(referencedAttachment(
        [event as never], 'file', String(fileRef.attachmentId), fileRef.name,
      )).toBeUndefined()
    }
  })

  it('fails closed when an assistant stream aggregates too many references', () => {
    const stream = Array.from({ length: 4097 }, (_, index) => ({
      type: 'chunk', time: index,
      chunk: { type: 'block-end', index, block: { type: 'file', attachment: fileRef } },
    }))
    expect(referencedAttachment(
      [{ type: 'assistant/attempt', data: { stream } } as never],
      'file', String(fileRef.attachmentId), fileRef.name,
    )).toBeUndefined()
  })

  it('requires the exact type, digest, and normalized name when scanning events', () => {
    const events = [{
      type: 'user/message',
      data: { content: [{ type: 'image', attachment: imageRef }, { type: 'file', attachment: fileRef }] },
    }] as never
    expect(referencedAttachment(events, 'file', String(fileRef.attachmentId), fileRef.name))
      .toEqual({ refType: 'file', ref: fileRef })
    expect(referencedAttachment(events, 'image', String(fileRef.attachmentId), fileRef.name)).toBeUndefined()
    expect(referencedAttachment(events, 'file', String(imageRef.attachmentId), fileRef.name)).toBeUndefined()
    expect(referencedAttachment(events, 'file', String(fileRef.attachmentId), 'other.txt')).toBeUndefined()
  })

  it('authorizes cold sessions and distinguishes missing storage from storage failure', async () => {
    const { ctx, session, fetch, observeSession } = await mounted()
    const cold = await fetch(request('cold-session', String(fileRef.attachmentId), 'file', 'notes.txt', { method: 'HEAD' }))
    expect(cold.status).toBe(200)

    observeSession.mockResolvedValueOnce({
      header: { ...session.header, cwd: undefined },
      inheritedEventCount: 0,
      events: [],
      [Symbol.dispose]() {},
    } as never)
    expect((await fetch(request(
      'missing-session', String(fileRef.attachmentId), 'file', 'notes.txt', { method: 'HEAD' },
    ))).status).toBe(404)

    observeSession.mockRejectedValueOnce(new Error('storage offline'))
    expect((await fetch(request(
      'broken-session', String(fileRef.attachmentId), 'file', 'notes.txt', { method: 'HEAD' },
    ))).status).toBe(500)
    await ctx.fiber.dispose()
  })

  it('drops a rejected live index so a later request can rebuild it', async () => {
    const { ctx, session, fetch, observeSession } = await mounted()
    observeSession.mockRejectedValueOnce(new Error('temporary storage failure'))
    expect((await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'file', 'notes.txt', { method: 'HEAD' },
    ))).status).toBe(500)
    expect((await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'file', 'notes.txt', { method: 'HEAD' },
    ))).status).toBe(200)
    expect(observeSession).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('fails closed when image bytes cannot be read', async () => {
    const { ctx, session, fetch, readImage } = await mounted()
    readImage.mockRejectedValueOnce(new Error('blob missing'))
    const response = await fetch(request(String(session.id), String(imageRef.attachmentId), 'image'))
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('source unavailable')
    await ctx.fiber.dispose()
  })

  it('cancels the backing file iterator when the response body is cancelled', async () => {
    const { ctx, session, fetch, readFileStream } = await mounted()
    const iterator = (async function* () { yield Uint8Array.of(9) })()
    const returnIterator = vi.spyOn(iterator, 'return')
    readFileStream.mockReturnValueOnce(iterator)
    const response = await fetch(request(String(session.id), String(fileRef.attachmentId), 'file'))
    await response.body?.cancel('stop')
    expect(returnIterator).toHaveBeenCalledWith('stop')
    await ctx.fiber.dispose()
  })

  it('uses safe fallback names and a binary media type for unnamed references', async () => {
    const { ctx, session, fetch } = await mounted()
    const { name: _imageName, ...imageWithoutName } = imageRef
    const { name: _fileName, ...fileWithoutName } = fileRef
    const unnamedImage = { ...imageWithoutName, attachmentId: AttachmentId(`sha256:${'5'.repeat(64)}`) }
    const opaqueImage = {
      ...imageWithoutName, attachmentId: AttachmentId(`sha256:${'6'.repeat(64)}`), mediaType: 'image' as 'image/png',
    }
    const unnamedFile = {
      ...fileWithoutName,
      attachmentId: AttachmentId(`sha256:${'7'.repeat(64)}`),
    } as FileAttachmentRef
    const unknownFile = { ...fileRef, attachmentId: AttachmentId(`sha256:${'8'.repeat(64)}`), name: 'payload.unknownext' }
    session.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: unnamedImage },
        { type: 'image', attachment: opaqueImage },
        { type: 'file', attachment: unnamedFile },
        { type: 'file', attachment: unknownFile },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect((await fetch(request(String(session.id), String(unnamedImage.attachmentId), 'image', 'image.png', { method: 'HEAD' }))).status).toBe(200)
    expect((await fetch(request(String(session.id), String(opaqueImage.attachmentId), 'image', 'image.bin', { method: 'HEAD' }))).status).toBe(200)
    expect((await fetch(request(String(session.id), String(unnamedFile.attachmentId), 'file', 'attachment.bin', { method: 'HEAD' }))).status).toBe(200)
    const unknown = await fetch(request(String(session.id), String(unknownFile.attachmentId), 'file', unknownFile.name, { method: 'HEAD' }))
    expect(unknown.headers.get('content-type')).toBe('application/octet-stream')
    await ctx.fiber.dispose()
  })

  it('rejects invalid encoded names and invalid logged names', async () => {
    const { ctx, session, fetch } = await mounted()
    const base = request(String(session.id), String(fileRef.attachmentId), 'file')
    const withEncodedName = (encoded: string) => {
      const url = new URL(base.url)
      url.searchParams.set('nameB64', encoded)
      return new Request(url, { headers: base.headers })
    }
    for (const encoded of [
      '', '*', 'A', Buffer.from('e\u0301.txt').toString('base64url'),
      Buffer.from('bad/name').toString('base64url'), Buffer.from([0xff]).toString('base64url'),
    ]) {
      expect((await fetch(withEncodedName(encoded))).status).toBe(400)
    }
    expect((await fetch(request('bad/session', String(fileRef.attachmentId), 'file'))).status).toBe(400)
    expect((await fetch(request(String(session.id), String(fileRef.attachmentId), 'other' as 'file'))).status).toBe(400)

    expect((await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'file', fileRef.name, { method: 'HEAD' },
    ))).status).toBe(200)
    for (const [index, name] of ['', 'bad/name', 'x'.repeat(1025)].entries()) {
      const digestCharacter = ['9', 'a', 'b'][index] as string
      const invalid = { ...fileRef, attachmentId: AttachmentId(`sha256:${digestCharacter.repeat(64)}`), name }
      session.append('user/message', createUserMessage({
        content: [{ type: 'file', attachment: invalid }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect(referencedAttachment(
        session.snapshotEvents(), 'file', String(invalid.attachmentId), name,
      )).toBeUndefined()
    }
    await ctx.fiber.dispose()
  })

  it('rejects duplicate and unexpected exact-size query key sets', async () => {
    const { ctx, fetch } = await mounted()
    const headers = { [ATTACHMENT_EXPORT_ACTION_HEADER]: ATTACHMENT_EXPORT_ACTION }
    expect((await fetch(new Request(
      `http://host${ATTACHMENT_EXPORT_PATH}?sessionId=a&sessionId=b&attachmentId=${fileRef.attachmentId}&refType=file`,
      { headers },
    ))).status).toBe(400)
    expect((await fetch(new Request(
      `http://host${ATTACHMENT_EXPORT_PATH}?sessionId=a&attachmentId=${fileRef.attachmentId}&refType=file&unexpected=x`,
      { headers },
    ))).status).toBe(400)
    await ctx.fiber.dispose()
  })

  it('rejects extra query fields, malformed digests, ranges, and unsupported action values', async () => {
    const { ctx, session, fetch } = await mounted()
    const base = request(String(session.id), String(fileRef.attachmentId), 'file')
    const extra = new Request(`${base.url}&extra=1`, { headers: base.headers })
    expect((await fetch(extra)).status).toBe(400)
    expect((await fetch(request(String(session.id), 'not-a-digest', 'file'))).status).toBe(400)
    expect((await fetch(request(String(session.id), String(fileRef.attachmentId), 'file', 'notes.txt', {
      headers: { range: 'bytes=0-1' },
    }))).status).toBe(400)
    expect((await fetch(new Request(base.url, {
      headers: { [ATTACHMENT_EXPORT_ACTION_HEADER]: 'wrong' },
    }))).status).toBe(403)
    await ctx.fiber.dispose()
  })

  it('removes the exact route with its owner fiber', async () => {
    const { ctx, session, fetch } = await mounted()
    await ctx.fiber.dispose()
    expect((await fetch(request(
      String(session.id), String(fileRef.attachmentId), 'file',
    ))).status).toBe(404)
  })
})
