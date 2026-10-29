/** REQ-20261021-0013: bounded transport fragments of redacted Host Evidence. */
import { createHash } from 'node:crypto'
import type { HostMemoryEvidence } from './memory-evidence-index.ts'
import { HostAuthorityError } from './types.ts'

const CHUNK_BYTES = 8 * 1024
const MAX_EVIDENCE_BYTES = 100_000

/** Exact byte range and whole-text digest for a later verified reassembly. */
export interface HostMemoryEvidenceChunk {
  readonly sourceRef: string
  readonly sourceVersion: string
  readonly eventSeq: number
  readonly kind: HostMemoryEvidence['kind']
  readonly source: HostMemoryEvidence['source']
  readonly offset: number
  readonly totalBytes: number
  readonly textDigest: string
  readonly bytesBase64url: string
  readonly nextOffset: number | null
}

/** Slice only a redacted Evidence record; callers must reauthorize every fragment. */
export function chunkHostMemoryEvidence(evidence: HostMemoryEvidence, offset: number): HostMemoryEvidenceChunk {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HostAuthorityError('invalid_input')
  const bytes = Buffer.from(evidence.text, 'utf8')
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES
    || bytes.toString('utf8') !== evidence.text || offset >= bytes.length)
    throw new HostAuthorityError('invalid_input')
  const end = Math.min(offset + CHUNK_BYTES, bytes.length)
  return Object.freeze({
    sourceRef: evidence.sourceRef, sourceVersion: evidence.sourceVersion,
    eventSeq: evidence.eventSeq, kind: evidence.kind,
    source: Object.freeze({ ownerUserId: evidence.source.ownerUserId,
      installationId: evidence.source.installationId, profileId: evidence.source.profileId,
      sessionId: evidence.source.sessionId, formatVersion: evidence.source.formatVersion }),
    offset, totalBytes: bytes.length,
    textDigest: createHash('sha256').update(bytes).digest('hex'),
    bytesBase64url: bytes.subarray(offset, end).toString('base64url'),
    nextOffset: end === bytes.length ? null : end,
  })
}
