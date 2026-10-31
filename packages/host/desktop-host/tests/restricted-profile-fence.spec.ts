import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RestrictedProfileFence } from '../src/restricted-profile-fence.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const uid = process.getuid?.() ?? 0
const profile = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150'
const other = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3151'

describe('restricted Profile durable fence', () => {
  it('survives reopening and requires exact operation and proven quiescence to clear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fence-'))
    let lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-test' })
    onTestFinished(async () => { await lock.release(); await rm(root, { recursive: true, force: true }) })
    const fence = new RestrictedProfileFence(root, uid, lock)
    const operation = fence.begin(profile)
    await lock.release()
    lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-restart' })
    const reopened = new RestrictedProfileFence(root, uid, lock)
    expect(reopened.pending(profile)).toBe(operation)
    expect(reopened.pending(other)).toBeUndefined()
    expect(() => reopened.begin(profile)).toThrow('conflict')
    expect(() => reopened.clear(profile, other, () => {})).toThrow('conflict')
    expect(() => reopened.clear(profile, operation, () => { throw Error('writer_alive') })).toThrow('writer_alive')
    expect(reopened.pending(profile)).toBe(operation)
    reopened.clear(profile, operation, () => {})
    expect(new RestrictedProfileFence(root, uid, lock).pending(profile)).toBeUndefined()
    const next = reopened.begin(profile)
    expect(next).not.toBe(operation)
    expect(() => reopened.clear(profile, operation, () => {})).toThrow('conflict')
    expect(reopened.pending(profile)).toBe(next)
  })

  it('rejects a substituted marker or a lost Host lease without changing the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fence-'))
    const lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-test' })
    onTestFinished(async () => { await lock.release(); await rm(root, { recursive: true, force: true }) })
    const fence = new RestrictedProfileFence(root, uid, lock)
    const outside = join(root, 'outside')
    await writeFile(outside, 'untouched', { mode: 0o600 })
    await symlink(outside, join(root, `${profile}.json`))
    expect(() => fence.begin(profile)).toThrow()
    expect(await readFile(outside, 'utf8')).toBe('untouched')
    expect(fence.pending(other)).toBeUndefined()
    await lock.release()
    expect(() => fence.begin(other)).toThrow('stale')
  })

  it('blocks only the fenced Profile after supervisor restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fence-'))
    const lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-test' })
    const fence = new RestrictedProfileFence(root, uid, lock)
    const operation = fence.begin(profile)
    const starts: string[] = []
    const supervisor = new ProfileWorkerSupervisor(async spec => {
      starts.push(spec.profileId)
      return { closeNotifications() {}, abort() {}, done: Promise.resolve() }
    }, id => fence.pending(id) !== undefined)
    onTestFinished(async () => { await supervisor.disposeAll(); await lock.release(); await rm(root, { recursive: true, force: true }) })
    const input = (id: string) => ({ profileId: id, profileRoot: root, credentialHandle: 'fixture', pluginRoots: [] })
    await expect(supervisor.start(input(profile))).rejects.toMatchObject({ code: 'unavailable' })
    await expect(supervisor.withPreparation(profile, async () => {})).rejects.toMatchObject({ code: 'unavailable' })
    expect(supervisor.isProfileBlocked(profile)).toBe(true)
    await supervisor.start(input(other))
    expect(starts).toEqual([other])
    fence.clear(profile, operation, () => {})
    await supervisor.start(input(profile))
    expect(starts).toEqual([other, profile])
  })
})
