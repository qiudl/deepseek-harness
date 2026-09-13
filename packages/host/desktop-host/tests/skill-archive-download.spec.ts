import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { archiveSource, downloadSkillArchive } from '../src/skill-archive-download.ts'

const bytes = Buffer.from('confirmed archive')
const source = { url: 'https://codeload.github.com/owner/repo/zip/refs/heads/main', subPath: 'skills/demo', sha256: createHash('sha256').update(bytes).digest('hex') }
afterEach(() => { vi.unstubAllGlobals() })

it('accepts only closed public GitHub archive descriptors', () => {
  expect(archiveSource(source)).toEqual(source)
  for (const url of ['http://codeload.github.com/owner/repo/zip/refs/heads/main', 'https://localhost/repo.zip',
    'https://codeload.github.com.evil.test/owner/repo/zip/refs/heads/main', `${source.url}?token=secret`,
    'https://user:pass@codeload.github.com/owner/repo/zip/refs/heads/main']) {
    expect(() => archiveSource({ ...source, url })).toThrow()
  }
  expect(() => archiveSource({ ...source, subPath: '../outside' })).toThrow()
  expect(() => archiveSource({ ...source, token: 'secret' })).toThrow()
})

it('matches the approved digest and refuses redirects without retrying', async () => {
  const fetcher = vi.fn(async () => new Response(bytes))
  vi.stubGlobal('fetch', fetcher)
  expect(await downloadSkillArchive(source, new AbortController().signal)).toEqual(bytes)
  expect(fetcher).toHaveBeenCalledWith(source.url, expect.objectContaining({ redirect: 'error' }))
  await expect(downloadSkillArchive({ ...source, sha256: '0'.repeat(64) }, new AbortController().signal)).rejects.toThrow('archive_changed')
  fetcher.mockRejectedValueOnce(new TypeError('redirect refused'))
  await expect(downloadSkillArchive(source, new AbortController().signal)).rejects.toThrow('redirect refused')
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('cancels oversized declared responses before reading and rejects an oversized stream', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(50 * 1024 * 1024 + 1) } }))
  await expect(downloadSkillArchive(source, new AbortController().signal)).rejects.toThrow('archive_download_failed')
  expect(cancel).toHaveBeenCalledOnce()
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(50 * 1024 * 1024 + 1)); controller.close()
  } })))
  await expect(downloadSkillArchive(source, new AbortController().signal)).rejects.toThrow('archive_limit')
})

it('rejects cancellation before download and after a response arrives', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn(async () => { controller.abort(); return new Response(bytes) })
  vi.stubGlobal('fetch', fetcher)
  await expect(downloadSkillArchive(source, controller.signal)).rejects.toThrow()
  await expect(downloadSkillArchive(source, controller.signal)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each([
  null, [], 'archive', { ...source, url: null }, { ...source, url: 'a'.repeat(2049) },
  { ...source, sha256: null }, { ...source, sha256: 'A'.repeat(64) },
  { ...source, subPath: null }, { ...source, subPath: 'a'.repeat(1025) },
  { ...source, url: 'https://codeload.github.com:8443/owner/repo/zip/refs/heads/main' },
  { ...source, url: 'https://:secret@codeload.github.com/owner/repo/zip/refs/heads/main' },
  { ...source, url: `${source.url}#fragment` },
  { ...source, url: 'https://codeload.github.com/owner/repo/tar.gz/refs/heads/main' },
])('rejects invalid archive capability fields: %#', (value) => {
  expect(() => archiveSource(value)).toThrow('invalid_archive_source')
})

it('accepts an archive rooted at the selected repository', () => {
  expect(archiveSource({ ...source, subPath: '' })).toEqual({ ...source, subPath: '' })
})

it.each([401, 204])('rejects HTTP %s instead of accepting an empty archive', async (status) => {
  vi.stubGlobal('fetch', async () => new Response(null, { status }))
  await expect(downloadSkillArchive(source, new AbortController().signal)).rejects.toThrow('archive_download_failed')
})

it('preserves cancellation when a bodyless response arrives after revocation', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', async () => { controller.abort(); return new Response(null, { status: 204 }) })
  await expect(downloadSkillArchive(source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
