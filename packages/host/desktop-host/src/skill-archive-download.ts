import { createHash } from 'node:crypto'
import { safeZipRelPath } from '#hub-skills'

/** Confirmed GitHub archive source and exact preview digest. */
export interface SkillArchiveSource { url: string; sha256: string; subPath: string }

/** @param value Untrusted plan fields. @returns Closed, public GitHub codeload descriptor. */
export function archiveSource(value: unknown): SkillArchiveSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_archive_source')
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== 3 || typeof v.url !== 'string' || v.url.length > 2048
    || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(v.sha256)
    || typeof v.subPath !== 'string' || v.subPath.length > 1024 || (v.subPath !== '' && safeZipRelPath(v.subPath) !== v.subPath)) {
    throw Error('invalid_archive_source')
  }
  const url = new URL(v.url)
  if (url.protocol !== 'https:' || url.hostname !== 'codeload.github.com' || url.port || url.username || url.password || url.search || url.hash
    || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/zip\/refs\/heads\/[A-Za-z0-9_.%-]+$/u.test(url.pathname)) throw Error('invalid_archive_source')
  return { url: url.href, sha256: v.sha256, subPath: v.subPath }
}

/**
 * Download the exact archive approved by Main, without redirects or retries.
 * @param source Validated descriptor.
 * @param signal Operation lifetime.
 * @returns At most 50 MiB whose digest matches the preview; no files are written here.
 */
export async function downloadSkillArchive(source: SkillArchiveSource, signal: AbortSignal): Promise<Buffer> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  lifetime.throwIfAborted()
  const response = await fetch(source.url, { redirect: 'error', signal: lifetime })
  if (lifetime.aborted) { await response.body?.cancel(); lifetime.throwIfAborted() }
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 50 * 1024 * 1024) {
    await response.body?.cancel(); throw Error('archive_download_failed')
  }
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of response.body) {
    lifetime.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > 50 * 1024 * 1024) throw Error('archive_limit')
    chunks.push(chunk)
  }
  lifetime.throwIfAborted()
  const buffer = Buffer.concat(chunks)
  if (createHash('sha256').update(buffer).digest('hex') !== source.sha256) throw Error('archive_changed')
  return buffer
}
