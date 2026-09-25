import { expect, it } from 'vitest'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

it('coalesces concurrent ensures and waits for an in-flight start before disposal', async () => {
  let start!: () => void; let done!: () => void; let count = 0; let aborted = false
  const ready = new Promise<void>((resolve) => { start = resolve })
  const stopped = new Promise<void>((resolve) => { done = resolve })
  const workers = new ProfileWorkerSupervisor(async () => {
    count++
    await ready
    return { closeNotifications() {}, abort() { aborted = true; done() }, done: stopped }
  })
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  const a = workers.ensure(input); const b = workers.ensure(input)
  const closing = workers.disposeAll()
  start(); await Promise.all([a, b, closing])
  expect(count).toBe(1)
  expect(aborted).toBe(true)
  await expect(workers.ensure(input)).rejects.toMatchObject({ code: 'unavailable' })
})

it('starts, activates, and disposes exactly one owned worker generation', async () => {
  const events: string[] = []
  const workers = new ProfileWorkerSupervisor(async spec => ({
    closeNotifications() { events.push('notifications') },
    abort() { events.push('abort') },
    done: Promise.resolve(),
    viewOrigin: `http://127.0.0.1/${spec.profileId}`,
    generation: 3,
    bootstrapCookie: { name: 'worker', value: 'private' },
  }))
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: ['plugin'] }

  await workers.start(input)
  await expect(workers.activate(input.profileId)).resolves.toEqual({
    origin: 'http://127.0.0.1/profile',
    generation: 3,
    bootstrapCookie: { name: 'worker', value: 'private' },
  })
  await expect(workers.start(input)).rejects.toMatchObject({ code: 'conflict' })
  await workers.dispose(input.profileId)
  await workers.dispose(input.profileId)
  expect(events).toEqual(['notifications', 'abort'])
  await expect(workers.activate(input.profileId)).rejects.toMatchObject({ code: 'unavailable' })
  await workers.disposeAll()
  await expect(workers.start(input)).rejects.toMatchObject({ code: 'unavailable' })
})

it('forwards model text only to a live worker that owns the model capability', async () => {
  const generateText = async (text: string, signal: AbortSignal) => ({
    provider: 'deepseek', model: 'deepseek-chat', text: `${text}:${String(signal.aborted)}`,
  })
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), generateText,
  }))
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  await expect(workers.generateText(input.profileId, 'before', new AbortController().signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await workers.start(input)
  await expect(workers.generateText(input.profileId, 'question', new AbortController().signal)).resolves.toEqual({
    provider: 'deepseek', model: 'deepseek-chat', text: 'question:false',
  })
  await workers.disposeAll()
  await expect(workers.generateText(input.profileId, 'after', new AbortController().signal))
    .rejects.toMatchObject({ code: 'unavailable' })

  const unsupported = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
  }))
  await unsupported.start(input)
  await expect(unsupported.generateText(input.profileId, 'question', new AbortController().signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  await unsupported.disposeAll()
})

it('forwards native follow events only through a live Profile worker', async () => {
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  const signal = new AbortController().signal
  const workers = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
    async *remoteUiStream(endpoint: string, payload: unknown, received: AbortSignal) {
      yield { endpoint, payload, sameSignal: received === signal }
    },
  }))
  expect(() => workers.remoteUiStream(input.profileId, 'session/follow', {}, signal))
    .toThrow('unavailable')
  await workers.start(input)
  const events: unknown[] = []
  for await (const event of workers.remoteUiStream(input.profileId, 'session/follow', { args: {} }, signal)) {
    events.push(event)
  }
  expect(events).toEqual([{ endpoint: 'session/follow', payload: { args: {} }, sameSignal: true }])
  await workers.disposeAll()
  expect(() => workers.remoteUiStream(input.profileId, 'session/follow', {}, signal))
    .toThrow('unavailable')

  const unsupported = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
  }))
  await unsupported.start(input)
  expect(() => unsupported.remoteUiStream(input.profileId, 'session/follow', {}, signal))
    .toThrow('unavailable')
  await unsupported.disposeAll()
})

it('refuses activation until every verified listener field is present', async () => {
  const handles = [
    {},
    { viewOrigin: 'http://127.0.0.1' },
    { viewOrigin: 'http://127.0.0.1', generation: 1 },
  ]
  for (const [index, fields] of handles.entries()) {
    const workers = new ProfileWorkerSupervisor(async () => ({
      closeNotifications() {}, abort() {}, done: Promise.resolve(), ...fields,
    }))
    const profileId = `profile-${index}`
    await workers.start({ profileId, profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] })
    await expect(workers.activate(profileId)).rejects.toMatchObject({ code: 'unavailable' })
    await workers.disposeAll()
  }
})

it('does not retain a failed start and reports worker shutdown failures', async () => {
  let attempts = 0
  const shutdownError = new Error('worker shutdown failed')
  const workers = new ProfileWorkerSupervisor(async () => {
    if (attempts++ === 0) throw new Error('worker start failed')
    return { closeNotifications() {}, abort() {}, done: Promise.reject(shutdownError) }
  })
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }

  await expect(workers.start(input)).rejects.toThrow('worker start failed')
  await workers.ensure(input)
  await expect(workers.disposeAll()).rejects.toBe(shutdownError)
})
