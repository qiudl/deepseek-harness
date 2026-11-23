import { expect, it, onTestFinished } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const input = { profileId: 'profile-a', profileRoot: '/fixture-a', credentialHandle: 'fixture', pluginRoots: [] }

it('waits for previously admitted Profile document writers before entering maintenance', async () => {
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(() => workers.disposeAll())
  let entered!: () => void, finish!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const release = new Promise<void>((resolve) => { finish = resolve })
  const events: string[] = []
  const admitted = workers.withProfileAdmission(input.profileId, async () => {
    entered()
    await release
    events.push('documents-flushed')
  })
  const stale = expect(admitted).rejects.toMatchObject({ code: 'unavailable' })
  await ready
  const maintenance = workers.withProfileMaintenance(input.profileId, async () => { events.push('snapshot') })
  expect(events).toEqual([])
  await expect(workers.withProfileAdmission(input.profileId, async () => {})).rejects.toMatchObject({ code: 'unavailable' })
  await expect(workers.withProfileAdmission('profile-b', async () => 'independent')).resolves.toBe('independent')
  finish()
  await Promise.all([stale, maintenance])
  expect(events).toEqual(['documents-flushed', 'snapshot'])
})

it('refuses a new upgrade while an admitted data migration completes without cancelling it', async () => {
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(() => workers.disposeAll())
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const completion = new Promise<void>((resolve) => { release = resolve })
  const mutation = workers.withProfileAdmission(input.profileId, async (guard) => {
    entered(); await completion; guard(); return 'committed'
  }, 'mutation')
  await ready
  await expect(workers.withProfileMaintenance(input.profileId, async () => 'must not snapshot')).rejects.toMatchObject({ code: 'unavailable' })
  release()
  await expect(mutation).resolves.toBe('committed')
  await expect(workers.withProfileMaintenance(input.profileId, async () => 'ready')).resolves.toBe('ready')
})

it('REQ-20261117-0005 fences the selected Profile while privately testing a fresh worker generation', async () => {
  let generation = 0
  const stopped: number[] = []
  const workers = new ProfileWorkerSupervisor(async () => {
    const id = ++generation
    return { generation: id, viewOrigin: `http://127.0.0.1:${32000 + id}`, bootstrapCookie: { name: 'fixture', value: 'private' },
      closeNotifications() {}, abort() { stopped.push(id) }, done: Promise.resolve(),
      generateText: async () => ({ provider: 'fixture', model: 'fixture', text: 'reply' }) }
  })
  onTestFinished(() => workers.disposeAll())
  await workers.start(input)
  await workers.start({ ...input, profileId: 'profile-b', profileRoot: '/fixture-b' })
  let retained: Parameters<Parameters<typeof workers.withProfileMaintenance>[1]>[0] | undefined
  await workers.withProfileMaintenance(input.profileId, async (permit) => {
    retained = permit
    expect(stopped).toContain(1)
    await expect(workers.activate(input.profileId)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(workers.ensure(input)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(workers.generateText('profile-b', 'text', new AbortController().signal)).resolves.toMatchObject({ text: 'reply' })
    await expect(permit.ensure({ ...input, profileId: 'profile-b' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await permit.ensure(input)
    expect((await permit.activate()).generation).toBe(3)
    await expect(workers.generateText(input.profileId, 'text', new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(workers.withProfileMaintenance(input.profileId, async () => {})).rejects.toMatchObject({ code: 'unavailable' })
  })
  expect((await workers.activate(input.profileId)).generation).toBe(3)
  await expect(retained!.activate()).rejects.toMatchObject({ code: 'stale' })
  await expect(retained!.ensure(input)).rejects.toMatchObject({ code: 'stale' })
})

it('REQ-20261117-0005 waits for shutdown and never exposes a failed candidate worker', async () => {
  let stopped = false
  const workers = new ProfileWorkerSupervisor(async () => ({
    generation: 1, viewOrigin: 'http://127.0.0.1:32101', bootstrapCookie: { name: 'fixture', value: 'private' },
    closeNotifications() {}, abort() { stopped = true }, done: Promise.resolve(),
  }))
  onTestFinished(() => workers.disposeAll())
  await workers.start(input)
  await expect(workers.withProfileMaintenance(input.profileId, async (permit) => {
    expect(stopped).toBe(true)
    await permit.ensure(input)
    throw Error('candidate failed')
  })).rejects.toThrow('candidate failed')
  await expect(workers.activate(input.profileId)).rejects.toMatchObject({ code: 'unavailable' })
  await workers.ensure(input)
  await expect(workers.activate(input.profileId)).resolves.toMatchObject({ generation: 1 })
})

it('REQ-20261117-0005 retains the fence when worker quiescence cannot be proven', async () => {
  const workers = new ProfileWorkerSupervisor(async () => {
    let reject!: (error: Error) => void
    const done = new Promise<void>((_resolve, failure) => { reject = failure })
    return { closeNotifications() {}, abort() { reject(Error('stop failed')) }, done }
  })
  onTestFinished(() => workers.disposeAll())
  await workers.start(input)
  await expect(workers.withProfileMaintenance(input.profileId, async () => { throw Error('must not run') }))
    .rejects.toThrow('stop failed')
  await expect(workers.ensure(input)).rejects.toMatchObject({ code: 'unavailable' })
})


it('refuses activation before a complete private worker exists and reuses a prepared private worker', async () => {
  let starts = 0
  const workers = new ProfileWorkerSupervisor(async () => {
    starts++
    return { closeNotifications() {}, abort() {}, done: Promise.resolve() }
  })
  onTestFinished(() => workers.disposeAll())
  await workers.withProfileMaintenance(input.profileId, async (permit) => {
    await expect(permit.activate()).rejects.toMatchObject({ code: 'unavailable' })
    await permit.ensure(input)
    await permit.ensure(input)
    await expect(permit.activate()).rejects.toMatchObject({ code: 'unavailable' })
  })
  expect(starts).toBe(1)
})

it('retains maintenance after a private candidate shutdown fails', async () => {
  const workers = new ProfileWorkerSupervisor(async () => {
    let reject!: (error: Error) => void
    const done = new Promise<void>((_resolve, rejected) => { reject = rejected })
    return { closeNotifications() {}, abort() { reject(Error('private stop failed')) }, done }
  })
  onTestFinished(() => workers.disposeAll())
  await expect(workers.withProfileMaintenance(input.profileId, async (permit) => {
    await permit.ensure(input)
    await permit.dispose()
  })).rejects.toThrow('private stop failed')
  await expect(workers.ensure(input)).rejects.toMatchObject({ code: 'unavailable' })
})

it('awaits admitted writers before final supervisor shutdown settles', async () => {
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const write = workers.withProfileAdmission(input.profileId, async () => { entered(); await barrier })
  const cancelled = expect(write).rejects.toMatchObject({ code: 'unavailable' })
  await ready
  const closing = workers.disposeAll()
  release()
  await Promise.all([closing, cancelled])
})

it('invalidates a captured coordination receiver before upgrade maintenance can expose a replacement', async () => {
  let generation = 0
  const workers = new ProfileWorkerSupervisor(async () => {
    const id = ++generation
    return { workerId: `worker-${id}`, closeNotifications() {}, abort() {}, done: Promise.resolve(),
      collaborationAnalysis: async () => ({ generation: id }) }
  })
  onTestFinished(() => workers.disposeAll())
  await workers.start(input)
  const original = workers.taskCoordinationReceiver(input.profileId)
  expect(() => { original.assertCurrent() }).not.toThrow()
  await workers.withProfileMaintenance(input.profileId, async (permit) => {
    expect(() => { original.assertCurrent() }).toThrow(expect.objectContaining({ code: 'unavailable' }))
    await expect(original.execute({}, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
    await permit.ensure(input)
    expect(() => workers.taskCoordinationReceiver(input.profileId)).toThrow(expect.objectContaining({ code: 'unavailable' }))
  })
  expect(() => { original.assertCurrent() }).toThrow(expect.objectContaining({ code: 'stale' }))
  const replacement = workers.taskCoordinationReceiver(input.profileId)
  expect(replacement.workerId).toBe('worker-2')
  await expect(replacement.execute({}, new AbortController().signal)).resolves.toEqual({ generation: 2 })
})
