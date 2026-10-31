import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
  it('distinguishes reservations before worker spawn and conservatively handles old records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fence-phase-'))
    const lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-phase-test' })
    onTestFinished(async () => { await lock.release(); await rm(root, { recursive: true, force: true }) })
    const fence = new RestrictedProfileFence(root, uid, lock)
    const operation = fence.begin(profile)
    expect(fence.reserved(profile)).toBe(operation)
    expect(new RestrictedProfileFence(root, uid, lock).reserved(profile)).toBe(operation)
    fence.markWorkerPossible(profile, operation)
    expect(fence.reserved(profile)).toBeUndefined()
    expect(fence.pending(profile)).toBe(operation)
    expect(() => fence.markWorkerPossible(profile, operation)).toThrow('stale')
    await writeFile(join(root, `${other}.json`), JSON.stringify({ version: 1, profileId: other,
      operationId: operation, state: 'pending' }), { mode: 0o600 })
    expect(fence.pending(other)).toBe(operation)
    expect(fence.reserved(other)).toBeUndefined()
  })

  it('clears only an empty, unstarted reservation after a trusted quiescence check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fence-empty-'))
    let lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-empty-test' })
    onTestFinished(async () => { await lock.release(); await rm(root, { recursive: true, force: true }) })
    let fence = new RestrictedProfileFence(root, uid, lock)
    const operation = fence.begin(profile)
    expect(fence.prepareEmptyReservationClear(profile, root, () => {}, () => false)).toBeUndefined()
    await lock.release()
    lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-empty-restarted' })
    fence = new RestrictedProfileFence(root, uid, lock)
    expect(fence.prepareEmptyReservationClear(profile, root, () => {}, () => true)).toBeUndefined()
    let checks = 0
    expect(() => fence.prepareEmptyReservationClear(profile, root, () => {}, () => ++checks > 1)).toThrow('stale')
    expect(fence.pending(profile)).toBe(operation)
    expect(() => fence.prepareEmptyReservationClear(profile, root, () => { throw Error('writer_active') }, () => false)).toThrow('writer_active')
    expect(fence.pending(profile)).toBe(operation)
    expect(() => fence.prepareEmptyReservationClear(profile, root, () => {
      mkdirSync(join(root, `restricted-${operation}`), { mode: 0o700 })
    }, () => false)).toThrow('unavailable')
    await rm(join(root, `restricted-${operation}`), { recursive: true })
    await mkdir(join(root, `restricted-${operation}`), { mode: 0o700 })
    const sentinel = join(root, `restricted-${operation}`, 'existing')
    await writeFile(sentinel, 'preserve', { mode: 0o600 })
    expect(() => fence.prepareEmptyReservationClear(profile, root, () => {}, () => false)).toThrow('unavailable')
    expect(await readFile(sentinel, 'utf8')).toBe('preserve')
    expect(fence.pending(profile)).toBe(operation)
    await rm(join(root, `restricted-${operation}`), { recursive: true })
    const finish = fence.prepareEmptyReservationClear(profile, root, () => {}, () => false)
    expect(fence.pending(profile)).toBe(operation)
    await mkdir(join(root, `restricted-${operation}`), { mode: 0o700 })
    expect(() => finish?.()).toThrow('unavailable')
    expect(fence.pending(profile)).toBe(operation)
    await rm(join(root, `restricted-${operation}`), { recursive: true })
    finish?.()
    expect(() => finish?.()).toThrow('stale')
    expect(fence.pending(profile)).toBeUndefined()
    const started = fence.begin(profile)
    fence.markWorkerPossible(profile, started)
    expect(fence.prepareEmptyReservationClear(profile, root, () => {}, () => false)).toBeUndefined()
    expect(fence.pending(profile)).toBe(started)
    fence.markWorkerGone(profile, started)
    expect(fence.emptyRecoveryCandidate(profile)).toBe(started)
    expect(fence.prepareEmptyReservationClear(profile, root, () => {}, () => false)).toBeUndefined()
    await lock.release()
    lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-empty-restarted-again' })
    fence = new RestrictedProfileFence(root, uid, lock)
    fence.prepareEmptyReservationClear(profile, root, () => {}, () => false)?.()
    expect(fence.pending(profile)).toBeUndefined()
  })

  it('recovers an empty reservation after its recorded owner process exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fence-owner-exit-'))
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await once(owner, 'spawn')
    if (owner.pid === undefined) throw new Error('missing fixture pid')
    let lock = await acquireSingleHostLock({ root, uid, pid: owner.pid, processNonce: 'restricted-owner-child-test' })
    onTestFinished(async () => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
      await lock.release().catch(() => {})
      await rm(root, { recursive: true, force: true })
    })
    const operation = new RestrictedProfileFence(root, uid, lock).begin(profile)
    await lock.release()
    lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-owner-restart-test' })
    const fence = new RestrictedProfileFence(root, uid, lock)
    const mayBeAlive = (pid: number) => {
      try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
    }
    expect(fence.pending(profile)).toBe(operation)
    expect(fence.prepareEmptyReservationClear(profile, root, () => {}, mayBeAlive)).toBeUndefined()
    const exited = once(owner, 'exit')
    owner.kill('SIGKILL')
    await exited
    fence.prepareEmptyReservationClear(profile, root, () => {}, mayBeAlive)?.()
    expect(fence.pending(profile)).toBeUndefined()
  })

  it('keeps its fence pending until the checked guard has actually released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fence-deferred-'))
    const lock = await acquireSingleHostLock({ root, uid, pid: process.pid, processNonce: 'restricted-fence-deferred' })
    onTestFinished(async () => { await lock.release(); await rm(root, { recursive: true, force: true }) })
    const fence = new RestrictedProfileFence(root, uid, lock)
    const operation = fence.begin(profile)
    expect(() => fence.prepareClear(profile, operation, () => { throw new Error('writer_alive') })).toThrow('writer_alive')
    expect(fence.pending(profile)).toBe(operation)
    const finalize = fence.prepareClear(profile, operation, () => {})
    expect(new RestrictedProfileFence(root, uid, lock).pending(profile)).toBe(operation)
    finalize()
    expect(fence.pending(profile)).toBeUndefined()
    expect(() => finalize()).toThrow('stale')
  })

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
