/** REQ-20261013-0021 / 24206. Connection-owned fixed package reads. */
import { expect, it, vi } from 'vitest'
import { SkillHubPackageSnapshotReads, SkillHubPackageTransferSnapshot } from '../src/skillhub-package-snapshot-reads.ts'

function input(bytes: Buffer, changes: Partial<Parameters<SkillHubPackageSnapshotReads['read']>[0]> = {}) {
  const controller = new AbortController()
  const capture = vi.fn(async () => bytes)
  const authorize = vi.fn()
  return { controller, capture, authorize, value: {
    ownerId: 'owner', bindingKey: 'operation:manifest', offset: 0,
    signal: controller.signal, capture, authorize, ...changes,
  } }
}

it('reuses one verified package across file objects and refreshes it for a manifest or new operation', async () => {
  const snapshots = new SkillHubPackageTransferSnapshot<number>()
  const capture = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3)
  expect(await snapshots.get('operation-1', capture, true)).toBe(1)
  expect(await snapshots.get('operation-1', capture)).toBe(1)
  expect(capture).toHaveBeenCalledTimes(1)
  expect(await snapshots.get('operation-1', capture, true)).toBe(2)
  expect(await snapshots.get('operation-2', capture)).toBe(3)
  expect(capture).toHaveBeenCalledTimes(3)
})

it('retries failed snapshot capture without clearing a newer refresh', async () => {
  const snapshots = new SkillHubPackageTransferSnapshot<number>()
  const failed = vi.fn(async () => { throw Error('capture_failed') })
  await expect(snapshots.get('operation', failed)).rejects.toThrow('capture_failed')
  const recovered = vi.fn(async () => 2)
  expect(await snapshots.get('operation', recovered)).toBe(2)

  let rejectOld!: (error: Error) => void
  const pending = snapshots.get('operation', () => new Promise<number>((_resolve, reject) => {
    rejectOld = reject
  }), true)
  await vi.waitFor(() => { expect(rejectOld).toBeTypeOf('function') })
  const refreshed = vi.fn(async () => 3)
  expect(await snapshots.get('operation', refreshed, true)).toBe(3)
  rejectOld(Error('stale_capture_failed'))
  await expect(pending).rejects.toThrow('stale_capture_failed')
  expect(await snapshots.get('operation', refreshed)).toBe(3)
  expect(refreshed).toHaveBeenCalledOnce()
})

it('captures once and serves exact sequential chunks plus an identical retry', async () => {
  const reads = new SkillHubPackageSnapshotReads()
  const bytes = Buffer.alloc(70_000, 7)
  const h = input(bytes)
  const first = await reads.read(h.value)
  expect(first).toMatchObject({ totalBytes: bytes.length, complete: false })
  expect(first.chunk).toHaveLength(32 * 1024)
  const retry = await reads.read(h.value)
  expect(retry).toEqual(first)
  const second = await reads.read({ ...h.value, offset: first.chunk.length })
  const third = await reads.read({ ...h.value, offset: first.chunk.length + second.chunk.length })
  expect(Buffer.concat([first.chunk, second.chunk, third.chunk])).toEqual(bytes)
  expect(third.complete).toBe(true)
  expect(h.capture).toHaveBeenCalledOnce()
  expect(h.authorize).toHaveBeenCalledTimes(8)
  h.controller.abort()
})

it('rejects gaps, changed bindings, revocation, failed capture and oversized objects', async () => {
  const reads = new SkillHubPackageSnapshotReads()
  const gap = input(Buffer.alloc(40_000))
  await expect(reads.read({ ...gap.value, offset: 1 })).rejects.toThrow()
  await reads.read(gap.value)
  await expect(reads.read({ ...gap.value, bindingKey: 'other', offset: 32768 })).rejects.toThrow()
  const revoked = input(Buffer.from('value'), { ownerId: 'revoked' })
  revoked.authorize.mockImplementation(() => { throw Error('revoked') })
  await expect(reads.read(revoked.value)).rejects.toThrow('revoked')
  const failed = input(Buffer.from('unused'), { ownerId: 'failed',
    capture: async () => { throw Error('capture_failed') } })
  await expect(reads.read(failed.value)).rejects.toThrow('capture_failed')
  const oversized = input(Buffer.alloc(10 * 1024 * 1024 + 1), { ownerId: 'oversized' })
  await expect(reads.read(oversized.value)).rejects.toThrow()
  gap.controller.abort()
})

it('retains empty final retries, replaces a completed target and bounds active owners', async () => {
  const reads = new SkillHubPackageSnapshotReads()
  const empty = input(Buffer.alloc(0))
  expect(await reads.read(empty.value)).toEqual({ totalBytes: 0, chunk: Buffer.alloc(0), complete: true })
  expect(await reads.read(empty.value)).toEqual({ totalBytes: 0, chunk: Buffer.alloc(0), complete: true })
  const replacement = await reads.read({ ...empty.value, bindingKey: 'next', capture: async () => Buffer.from('next') })
  expect(replacement).toEqual({ totalBytes: 4, chunk: Buffer.from('next'), complete: true })
  await expect(reads.read({ ...empty.value, bindingKey: 'next', offset: 4,
    capture: async () => Buffer.from('next') })).rejects.toThrow()
  const controllers: AbortController[] = []
  for (let index = 0; index < 8; index++) {
    const current = input(Buffer.from([index]), { ownerId: `owner-${index}` })
    controllers.push(current.controller)
    await reads.read(current.value)
  }
  const ninth = input(Buffer.from('ninth'), { ownerId: 'owner-8' })
  await expect(reads.read(ninth.value)).rejects.toThrow()
  for (const controller of controllers) controller.abort()
})

it('rejects malformed coordinates and a request aborted before admission', async () => {
  const reads = new SkillHubPackageSnapshotReads()
  for (const changed of [
    { ownerId: '' }, { bindingKey: '' }, { offset: -1 }, { offset: 0.5 },
    { offset: 10 * 1024 * 1024 + 1 },
  ]) {
    const h = input(Buffer.from('value'), changed)
    await expect(reads.read(h.value)).rejects.toThrow()
  }
  const aborted = input(Buffer.from('value'))
  aborted.controller.abort()
  await expect(reads.read(aborted.value)).rejects.toThrow()
  const duringCapture = input(Buffer.from('unused'), { ownerId: 'during-capture' })
  let finish!: (bytes: Buffer) => void
  const pending = reads.read({ ...duringCapture.value,
    capture: () => new Promise<Buffer>((resolve) => { finish = resolve }) })
  await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
  duringCapture.controller.abort()
  finish(Buffer.from('late'))
  await expect(pending).rejects.toThrow()
})
