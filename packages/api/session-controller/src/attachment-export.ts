/** Desktop-only streamed attachment export over the authenticated Connection route. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  FileAttachmentRef,
  ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { assistantStreamChunks } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as sessionId } from '@deepseek-ai/dsh-session'
import { lookup as mediaTypeForName } from 'mime-types'
import { ApiSessionNotFound, inspectApiSession } from './agent.ts'

/** Exact authenticated route used only by the Slark Desktop main process. */
export const ATTACHMENT_EXPORT_PATH = '/api/session.attachment-export'
/** Browser Fetch forbids page JavaScript from setting a `Sec-` request header. */
export const ATTACHMENT_EXPORT_ACTION_HEADER = 'Sec-Slark-Desktop-Action'
/** Exact reserved-header value admitted by the Desktop attachment route. */
export const ATTACHMENT_EXPORT_ACTION = 'attachment-save-v1'

const DIGEST = /^sha256:[a-f0-9]{64}$/u
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const MAX_NAME_BYTES = 1024

type ExportRef =
  | { readonly refType: 'image'; readonly ref: ImageAttachmentRef }
  | { readonly refType: 'file'; readonly ref: FileAttachmentRef }

interface AttachmentExportConnection {
  readonly fetch: HostConnectionHandle['fetch']
}

/**
 * Register the exact Desktop attachment route in the current plugin fiber.
 * @param ctx - Host context carrying the authenticated connection and Session services.
 * @returns an asynchronous disposer for the registered route.
 */
export function installAttachmentExport(ctx: Context): () => Promise<void> {
  const authorization = new AttachmentAuthorizationIndex(ctx)
  return connectionOf(ctx).fetch.register({
    path: ATTACHMENT_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: request => attachmentExportResponse(ctx, request, authorization),
  })
}

/** Serve one already-authenticated Desktop attachment request. */
async function attachmentExportResponse(
  ctx: Context,
  request: Request,
  authorization: AttachmentAuthorizationIndex,
): Promise<Response> {
  if (request.headers.get(ATTACHMENT_EXPORT_ACTION_HEADER) !== ATTACHMENT_EXPORT_ACTION) {
    return plain('forbidden', 403)
  }
  if (request.headers.has('range')) return plain('invalid request', 400)
  const parsed = parseRequest(request)
  if (parsed === undefined) return plain('invalid request', 400)

  let authorized: ExportRef | undefined
  try {
    authorized = await authorization.resolve(
      parsed.sessionId,
      parsed.refType,
      parsed.attachmentId,
      parsed.name,
      request.signal,
    )
  } catch {
    request.signal.throwIfAborted()
    return plain('source unavailable', 500)
  }
  if (authorized === undefined) return plain('not found', 404)
  const name = exportName(authorized)
  /* v8 ignore next -- both authorization paths admit only references carrying this exact valid name. */
  if (name === undefined) return plain('not found', 404)
  const headers = responseHeaders(authorized, name)
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })

  if (authorized.refType === 'image') {
    try {
      const stored = await ctx.attachments.readImage(authorized.ref, request.signal)
      request.signal.throwIfAborted()
      return new Response(byteStream(stored.data, request.signal), { status: 200, headers })
    } catch {
      request.signal.throwIfAborted()
      return plain('source unavailable', 500)
    }
  }
  return new Response(
    iterableStream(ctx.attachments.readFileStream(authorized.ref, request.signal), request.signal),
    { status: 200, headers },
  )
}

function connectionOf(ctx: Context): AttachmentExportConnection {
  return Reflect.get(ctx, 'connection')
}

function parseRequest(request: Request): {
  readonly sessionId: SessionId
  readonly attachmentId: string
  readonly refType: ExportRef['refType']
  readonly name: string
} | undefined {
  /* v8 ignore next -- the registered Host route rejects every other method before invoking its handler. */
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
  const params = new URL(request.url).searchParams
  const keys = [...params.keys()]
  if (keys.length !== 4 || new Set(keys).size !== 4
    || !keys.every(key => ['sessionId', 'attachmentId', 'refType', 'nameB64'].includes(key))) {
    return undefined
  }
  // The exact-key check above establishes that each lookup is present.
  const rawSessionId = params.get('sessionId') as string
  const attachmentId = params.get('attachmentId') as string
  const refType = params.get('refType') as string
  const name = decodeName(params.get('nameB64') as string)
  if (!OPAQUE_ID.test(rawSessionId)
    || !DIGEST.test(attachmentId)
    || (refType !== 'image' && refType !== 'file') || name === undefined) return undefined
  return { sessionId: sessionId(rawSessionId), attachmentId, refType, name }
}

function contentAttachments(
  content: unknown,
): ExportRef[] {
  if (!Array.isArray(content)) return []
  const attachments: ExportRef[] = []
  const pending: Array<{ readonly blocks: unknown[]; readonly depth: number }> = [{ blocks: content, depth: 0 }]
  const visited = new WeakSet<object>()
  let scanned = 0
  while (pending.length > 0) {
    const next = pending.pop() as { readonly blocks: unknown[]; readonly depth: number }
    if (visited.has(next.blocks)) return []
    visited.add(next.blocks)
    for (const candidate of next.blocks) {
      scanned += 1
      if (scanned > 100_000) return []
      if (!candidate || typeof candidate !== 'object') continue
      const block = candidate as { readonly type?: unknown; readonly attachment?: unknown; readonly content?: unknown }
      if (block.type === 'image' && block.attachment && typeof block.attachment === 'object') {
        attachments.push({ refType: 'image', ref: block.attachment as ImageAttachmentRef })
      } else if (block.type === 'file' && block.attachment && typeof block.attachment === 'object') {
        attachments.push({ refType: 'file', ref: block.attachment as FileAttachmentRef })
      }
      if (attachments.length > 4096) return []
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        if (next.depth >= 32) return []
        pending.push({ blocks: block.content, depth: next.depth + 1 })
      }
    }
  }
  return attachments
}

function attachmentsInEvent(event: SessionEvent): ExportRef[] {
  const rawData: unknown = event.data
  const data = (rawData && typeof rawData === 'object' ? rawData : {}) as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: unknown
    readonly stream?: unknown
  }
  if (event.type === 'user/message') return contentAttachments(data.content)
  if (event.type === 'tool/result') return contentAttachments(data.message?.content)
  if (event.type === 'agent/inbox/spliced') {
    if (!Array.isArray(data.inserted)) return []
    const attachments: ExportRef[] = []
    for (const inserted of data.inserted) {
      const next = contentAttachments(
        inserted && typeof inserted === 'object' ? Reflect.get(inserted, 'content') : undefined,
      )
      if (attachments.length + next.length > 4096) return []
      attachments.push(...next)
    }
    return attachments
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const attachments = event.type === 'assistant/message'
      ? contentAttachments(data.message?.content)
      : []
    try {
      for (const chunk of assistantStreamChunks(data.stream as never, 'block-end')) {
        const next = contentAttachments([chunk.block])
        if (attachments.length + next.length > 4096) return []
        attachments.push(...next)
      }
    } catch {
      return []
    }
    return attachments
  }
  return []
}

/**
 * Resolve one exact durable attachment reference from authoritative Session events.
 * @param events - complete authoritative event prefix to inspect.
 * @param refType - required attachment kind.
 * @param attachmentId - required content-addressed attachment identity.
 * @param name - required normalized display name from the durable reference.
 * @returns the exact logged attachment reference, or `undefined` when it is absent.
 */
export function referencedAttachment(
  events: readonly SessionEvent[],
  refType: ExportRef['refType'],
  attachmentId: string,
  name: string,
): ExportRef | undefined {
  for (const event of events) {
    const found = attachmentsInEvent(event).find(attachment => (
      attachment.refType === refType
      && String(attachment.ref.attachmentId) === attachmentId
      && exportName(attachment) === name
    ))
    if (found !== undefined) return found
  }
  return undefined
}

class AttachmentAuthorizationIndex {
  private readonly live = new WeakMap<Session, {
    readonly index: Map<string, ExportRef>
    readonly ready: Promise<void>
  }>()

  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      const live = this.live.get(session)
      if (live !== undefined) this.add(live.index, attachmentsInEvent(event))
    })
  }

  async resolve(
    id: SessionId,
    refType: ExportRef['refType'],
    attachmentId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<ExportRef | undefined> {
    const attached = this.ctx.sessions.get(id)
    if (attached !== undefined) {
      signal.throwIfAborted()
      let live = this.live.get(attached)
      if (live === undefined) {
        const index = new Map<string, ExportRef>()
        const entry = {
          index,
          ready: inspectApiSession(this.ctx, id).then((inspected) => {
            for (const event of inspected.events) this.add(index, attachmentsInEvent(event))
          }),
        }
        live = entry
        this.live.set(attached, entry)
        void entry.ready.catch(() => {
          /* v8 ignore else -- this entry remains installed until its own ready promise settles. */
          if (this.live.get(attached) === entry) this.live.delete(attached)
        })
      }
      await live.ready
      signal.throwIfAborted()
      return live.index.get(this.key(refType, attachmentId, name))
    }
    try {
      const inspected = await inspectApiSession(this.ctx, id, signal)
      return referencedAttachment(inspected.events, refType, attachmentId, name)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ApiSessionNotFound) return undefined
      throw error
    }
  }

  private add(index: Map<string, ExportRef>, attachments: readonly ExportRef[]): void {
    for (const attachment of attachments) {
      const name = exportName(attachment)
      if (name !== undefined) {
        index.set(this.key(attachment.refType, String(attachment.ref.attachmentId), name), attachment)
      }
    }
  }

  private key(refType: ExportRef['refType'], attachmentId: string, name: string): string {
    return `${refType}:${attachmentId}:${Buffer.from(name, 'utf8').toString('base64url')}`
  }
}

function decodeName(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,1366}$/u.test(encoded)) return undefined
  const bytes = Buffer.from(encoded, 'base64url')
  // The encoded-length cap already limits decoded input to MAX_NAME_BYTES.
  if (bytes.toString('base64url') !== encoded) return undefined
  try {
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (name.normalize('NFC') !== name || /[\0/\\]/u.test(name)) return undefined
    return name
  } catch {
    return undefined
  }
}

function exportName(attachment: ExportRef): string | undefined {
  const fallback = attachment.refType === 'image'
    ? `image.${attachment.ref.mediaType.split('/')[1] ?? 'bin'}`
    : 'attachment.bin'
  const name = (attachment.ref.name ?? fallback).normalize('NFC')
  const bytes = Buffer.byteLength(name, 'utf8')
  return bytes > 0 && bytes <= MAX_NAME_BYTES && !/[\0/\\]/u.test(name) ? name : undefined
}

function responseHeaders(attachment: ExportRef, name: string): Headers {
  const mediaType = attachment.refType === 'image'
    ? attachment.ref.mediaType
    : mediaTypeForName(name) || 'application/octet-stream'
  return new Headers({
    'cache-control': 'private, no-store',
    'content-disposition': 'attachment; filename="attachment.bin"',
    'content-length': String(attachment.ref.bytes),
    'content-security-policy': 'sandbox',
    'content-type': mediaType,
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-dsh-attachment-bytes': String(attachment.ref.bytes),
    'x-dsh-attachment-id': String(attachment.ref.attachmentId),
    'x-dsh-attachment-name-b64': Buffer.from(name, 'utf8').toString('base64url'),
    'x-dsh-attachment-protocol': '1',
    'x-dsh-attachment-type': attachment.refType,
  })
}

function byteStream(data: Uint8Array, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      signal.throwIfAborted()
      controller.enqueue(data)
      controller.close()
    },
  })
}

function iterableStream(
  iterable: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      signal.throwIfAborted()
      const next = await iterator.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  })
}
