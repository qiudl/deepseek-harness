/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploads } from './index.ts'
import type { FileUploadReceiptId, FileUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue }
  | { readonly ok: true; readonly value: { readonly discarded: boolean } }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

type FileUploadHttpService = Pick<FileUploads, 'discardUpload' | 'uploadStream'>

/**
 * Handle one authenticated raw-byte upload or staged-receipt discard.
 * @param service - Host upload service receiving the operation.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON result using HTTP status 200 after request validation.
 */
export async function handleFileUploadHttp(service: FileUploadHttpService, request: Request): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
  }
  if (request.method === 'POST') {
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/octet-stream') {
      return new Response('content type must be application/octet-stream', { status: 415 })
    }
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  if (request.method === 'DELETE') {
    const receiptId = url.searchParams.get('receiptId')
    if (receiptId === null || receiptId === '') {
      return new Response('receiptId is required', { status: 400 })
    }
    return jsonResult(await invoke(async () => ({
      ok: true,
      value: {
        discarded: await service.discardUpload(
          brandString<SessionId>(sessionId),
          brandString<FileUploadReceiptId>(receiptId),
        ),
      },
    })))
  }
  const name = url.searchParams.get('name') ?? undefined
  return jsonResult(await invoke(async () => ({
    ok: true,
    value: await service.uploadStream({
      sessionId: brandString<SessionId>(sessionId),
      data: requestBodyChunks(request.body),
      signal: request.signal,
      ...(name === undefined ? {} : { name }),
    }),
  })))
}

async function invoke(operation: () => Promise<FileUploadHttpResult>): Promise<FileUploadHttpResult> {
  try {
    return await operation()
  } catch (error) {
    const failure = remoteErrorOf(error)
    return {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
}

function jsonResult(result: FileUploadHttpResult): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}
