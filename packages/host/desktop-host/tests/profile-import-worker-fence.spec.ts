import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FileProfileImportFenceFiles, ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const sourceId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120'
const targetId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
const operationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
const otherId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3123'
const uid = process.getuid?.() ?? 0

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-fence-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await Promise.all([sourceId, targetId].map(id => mkdir(join(root, id), { mode: 0o700 })))
  const files = new FileProfileImportFenceFiles(root, uid)
  return { root, files, gate: new ProfileImportWorkerFence(files) }
}

describe('durable Profile import worker fence', () => {
  it('reserves both Profiles and reopens them only after matching cleanup', async () => {
    const { files, gate } = await fixture()
    gate.reservePair(sourceId, targetId, operationId)
    gate.reservePair(sourceId, targetId, operationId)
    const restarted = new ProfileImportWorkerFence(files)
    expect(() => restarted.assertOpen(sourceId)).toThrow(/unavailable/u)
    expect(() => restarted.assertOpen(targetId)).toThrow(/unavailable/u)
    expect(() => restarted.reservePair(sourceId, targetId, otherId)).toThrow(/conflict/u)
    expect(() => restarted.clearPair(sourceId, targetId, otherId)).toThrow(/conflict/u)
    restarted.clearPair(sourceId, targetId, operationId)
    restarted.assertOpen(sourceId)
    restarted.assertOpen(targetId)
  })

  it('keeps a partial reservation closed across restart and refuses malformed markers', async () => {
    const { root, files } = await fixture()
    let writes = 0
    const gate = new ProfileImportWorkerFence({
      read: id => files.read(id),
      replace: (id, bytes) => {
        writes += 1
        if (writes === 2) throw new Error('second marker failed')
        files.replace(id, bytes)
      },
    })
    expect(() => gate.reservePair(sourceId, targetId, operationId)).toThrow('second marker failed')
    const restarted = new ProfileImportWorkerFence(new FileProfileImportFenceFiles(root, uid))
    expect(() => restarted.assertOpen(sourceId)).toThrow(/unavailable/u)
    restarted.clearPair(sourceId, targetId, operationId)
    restarted.assertOpen(sourceId)
    restarted.assertOpen(targetId)
    restarted.reservePair(sourceId, targetId, operationId)
    restarted.assertOwnedPair(sourceId, targetId, operationId)
    await writeFile(join(root, sourceId, 'profile-import-fence.v1.json'), '{bad', { mode: 0o600 })
    expect(() => restarted.assertOpen(sourceId)).toThrow(/unavailable/u)
  })

  it('waits for both worker exits and retains markers if either stop fails', async () => {
    const { gate } = await fixture()
    const order: string[] = []
    await expect(gate.quiescePair({ sourceProfileId: sourceId, targetProfileId: targetId, operationId,
      revoke: (id) => { order.push(`revoke:${id}`) },
      stop: (id) => { order.push(`stop:${id}`); if (id === targetId) throw new Error('stop failed'); return Promise.resolve() },
    })).rejects.toThrow('stop failed')
    expect(order).toEqual([`revoke:${sourceId}`, `revoke:${targetId}`, `stop:${sourceId}`, `stop:${targetId}`])
    expect(() => gate.assertOpen(sourceId)).toThrow(/unavailable/u)
    expect(() => gate.assertOpen(targetId)).toThrow(/unavailable/u)
  })

  it('rejects a linked marker and closes a worker started while its fence is written', async () => {
    const { root, gate } = await fixture()
    const marker = join(root, sourceId, 'profile-import-fence.v1.json')
    const linked = join(root, 'linked.json')
    await writeFile(linked, '{}', { mode: 0o600 })
    await symlink(linked, marker)
    expect(() => gate.assertOpen(sourceId)).toThrow()
    await rm(marker)
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const closed = vi.fn()
    const supervisor = new ProfileWorkerSupervisor(async () => {
      gate.reservePair(sourceId, targetId, operationId)
      return { closeNotifications: closed, abort: finish, done }
    }, id => gate.assertOpen(id))
    await expect(supervisor.ensure({ profileId: sourceId, profileRoot: join(root, sourceId),
      credentialHandle: 'key', pluginRoots: [] })).rejects.toThrow(/unavailable/u)
    expect(closed).toHaveBeenCalledOnce()
    await expect(supervisor.activate(sourceId)).rejects.toThrow(/unavailable/u)
    expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ operationId, state: 'pending' })
  })

  it('adopts one candidate under the matching fence and owns its later disposal', async () => {
    const { gate } = await fixture()
    gate.reservePair(sourceId, targetId, operationId)
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const abort = vi.fn(() => finish())
    const candidate = { viewOrigin: 'http://127.0.0.1:43123', generation: 1,
      bootstrapCookie: { name: 'fixture', value: 'private' },
      closeNotifications: vi.fn(), abort, done }
    const workers = new ProfileWorkerSupervisor(async () => { throw Error('ordinary start not expected') },
      id => gate.assertOpen(id))
    await workers.adoptImportCandidate(targetId, candidate,
      () => gate.assertOwnedPair(sourceId, targetId, operationId))
    await expect(workers.activate(targetId)).rejects.toThrow(/unavailable/u)
    gate.clearPair(sourceId, targetId, operationId)
    expect(await workers.activate(targetId)).toMatchObject({ origin: candidate.viewOrigin, generation: 1 })
    await workers.disposeAll()
    expect(abort).toHaveBeenCalledOnce()
    expect(candidate.closeNotifications).toHaveBeenCalledOnce()
  })

  it('stops a candidate that cannot be adopted', async () => {
    const { gate } = await fixture()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const abort = vi.fn(() => finish())
    const candidate = { viewOrigin: 'http://127.0.0.1:43123', generation: 1,
      bootstrapCookie: { name: 'fixture', value: 'private' },
      closeNotifications: vi.fn(), abort, done }
    const workers = new ProfileWorkerSupervisor(async () => { throw Error('ordinary start not expected') },
      id => gate.assertOpen(id))
    await expect(workers.adoptImportCandidate(targetId, candidate,
      () => gate.assertOwnedPair(sourceId, targetId, operationId))).rejects.toThrow(/conflict/u)
    expect(abort).toHaveBeenCalledOnce()
    expect(candidate.closeNotifications).toHaveBeenCalledOnce()
    await workers.disposeAll()
  })
})
