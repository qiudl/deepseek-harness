/** Browser-safe request and receipt types for staged file uploads. */

import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Canonical encoded upload accepted by the Remote fallback. */
export interface EncodedFileUploadRequest {
  /** Canonical base64 encoding of the exact file bytes. */
  readonly data: string
  /** Optional display name; the Host sanitizes it into the stored leaf name. */
  readonly name?: string
}

/** Durable receipt for one staged file upload. */
export interface FileUploadValue {
  /** Per-upload authority accepted only inside the receiving Agent scope. */
  readonly receiptId: FileUploadReceiptId
  readonly file: FileAttachmentRef
}

/** Host-minted authority for one staged file upload in one Agent scope. */
export type FileUploadReceiptId = Branded<'file-upload-receipt-id'>

/** Monotone byte progress emitted by a page-owned upload carrier. */
export interface FileUploadCarrierProgress {
  readonly loaded: number
  readonly total?: number
}

/**
 * Sends one upload through a page-owned Host transport.
 * @param input - document-relative upload route; the carrier resolves it against its own base.
 * @param init - raw request body, headers, and cancellation signal.
 * @param onProgress - optional observer for monotone uploaded byte counts.
 * @returns the Host response.
 */
export type FileUploadFetch = (
  input: string | URL,
  init: RequestInit,
  onProgress?: (progress: FileUploadCarrierProgress) => void,
) => Promise<Response>

/** Pre-Cordis hook supplied by a page whose Host runs in another execution context. */
export interface ClientFileUploadHooks {
  readonly fetch: FileUploadFetch
}
