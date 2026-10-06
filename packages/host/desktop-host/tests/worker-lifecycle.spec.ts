import { expect, it, onTestFinished, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { parseHostCollaborationDeliveryCapsule, parseHostCollaborationSourceTarget,
  parseHostCollaborationSourceDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

it('reads the exact original worker reference grant and refuses changed digests, cancellation and missing workers', async () => {
  const target = parseHostCollaborationSourceTarget({ workspace_id: '123e4567-e89b-42d3-a456-426614174000',
    session_id: 'session', source_message_id: 'message', source_revision: '1' })
  const digest = 'b'.repeat(64) as never
  const read = vi.fn(async () => ({ ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: digest }))
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
    readCollaborationReferenceGrant: read }))
  onTestFinished(() => workers.disposeAll())
  const signal = new AbortController().signal
  await expect(workers.readCollaborationReferenceGrant('profile', target, digest, signal)).rejects.toMatchObject({ code: 'unavailable' })
  await workers.ensure({ profileId: 'profile', profileRoot: '/owned', credentialHandle: 'key', pluginRoots: [] })
  expect(await workers.readCollaborationReferenceGrant('profile', target, digest, signal)).toEqual(await read())
  expect(read).toHaveBeenCalledWith(target, digest, signal)
  read.mockResolvedValue({ ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: 'c'.repeat(64) as never })
  await expect(workers.readCollaborationReferenceGrant('profile', target, digest, signal)).rejects.toMatchObject({ code: 'profile_mismatch' })
  await expect(workers.readCollaborationReferenceGrant('profile', target, digest, AbortSignal.abort())).rejects.toThrow()
  read.mockImplementationOnce(async () => {
    await workers.disposeAll()
    return { ...target, snapshot_digest: 'a'.repeat(64), reference_request_digest: digest }
  })
  await expect(workers.readCollaborationReferenceGrant('profile', target, digest, signal)).rejects.toMatchObject({ code: 'stale' })
})

it('denies private collaboration operations when the original worker is missing, unsupported or closed', async () => {
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'key', pluginRoots: [] }
  const target = parseHostCollaborationSourceTarget({ workspace_id: '123e4567-e89b-42d3-a456-426614174000',
    session_id: 'session', source_message_id: 'message', source_revision: '1' })
  const denied = async () => {
    await expect(workers.inspectCollaborationSource(input.profileId, target, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(workers.readCollaborationSourceSnapshot(input.profileId, target, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(workers.collaborationAnalysis(input.profileId, {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(() => workers.collaborationDeliveryReceiver(input.profileId)).toThrow('unavailable')
  }
  try {
    await denied()
    await workers.start(input)
    await denied()
    await workers.disposeAll()
    await denied()
  } finally { await workers.disposeAll() }
})

it.each(['replacement', 'closure', 'cancellation'])('discards analysis after worker %s before settlement', async (cause) => {
  let release!: () => void, enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const command = { action: 'prepare', input: { source_message_id: 'message' } }
  const response = { kind: 'prepared', descriptor: { source_message_id: 'message' } }
  let generation = 0
  let blocked = false
  const workers = new ProfileWorkerSupervisor(async () => {
    const current = ++generation
    return { closeNotifications() {}, abort() {}, done: Promise.resolve(),
      collaborationAnalysis: async (received: HostRemoteSessionJson, receivedSignal: AbortSignal) => {
        expect(received).toBe(command)
        expect(receivedSignal.aborted).toBe(false)
        if (current === 1 && !blocked) {
          blocked = true
          await new Promise<void>((resolve) => { release = resolve; enter() })
        }
        return response
      },
    }
  })
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'key', pluginRoots: [] }
  try {
    await workers.start(input)
    await expect(workers.collaborationAnalysis(input.profileId, command, AbortSignal.abort())).rejects.toThrow()
    const cancellation = new AbortController()
    const pending = workers.collaborationAnalysis(input.profileId, command, cancellation.signal)
    const denied = expect(pending).rejects.toMatchObject(cause === 'cancellation' ? { name: 'AbortError' } : { code: 'stale' })
    await entered
    if (cause === 'replacement') {
      await workers.dispose(input.profileId)
      await workers.start(input)
    } else if (cause === 'closure') await workers.disposeAll()
    else cancellation.abort()
    release()
    await denied
    if (cause !== 'closure')
      expect(await workers.collaborationAnalysis(input.profileId, command, new AbortController().signal)).toBe(response)
    await workers.disposeAll()
    await expect(workers.collaborationAnalysis(input.profileId, command, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' })
  } finally { release?.(); await workers.disposeAll() }
})

it('refuses Source descriptors and complete snapshots belonging to another original message', async () => {
  const target = parseHostCollaborationSourceTarget({ workspace_id: '123e4567-e89b-42d3-a456-426614174000',
    session_id: 'session', source_message_id: 'message', source_revision: '1' })
  for (const change of [{ workspace_id: '223e4567-e89b-42d3-a456-426614174000' }, { session_id: 'other' },
    { source_message_id: 'other' }, { source_revision: '2' }]) {
    const descriptor = parseHostCollaborationSourceDescriptor({ ...target, ...change, snapshot_digest: 'a'.repeat(64) })
    const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
      inspectCollaborationSource: async () => descriptor,
      readCollaborationSourceSnapshot: async () => ({ descriptor, snapshot_json: '{}' }),
    }))
    const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'key', pluginRoots: [] }
    try {
      await workers.start(input)
      await expect(workers.inspectCollaborationSource(input.profileId, target, new AbortController().signal))
        .rejects.toMatchObject({ code: 'profile_mismatch' })
      await expect(workers.readCollaborationSourceSnapshot(input.profileId, target, new AbortController().signal))
        .rejects.toMatchObject({ code: 'profile_mismatch' })
    } finally { await workers.disposeAll() }
  }
})

it('captures one original reply worker across fragments and refuses a commit after that worker is replaced', async () => {
  const payload = parseHostCollaborationDeliveryCapsule({ namespace_id: 'ns', projection: {
    delivery_id: 'd', invocation_id: 'i', plan_id: 'p', task_id: 't', task_revision: '1',
    source_locator: { workspace_id: '123e4567-e89b-42d3-a456-426614174000', session_id: 's', source_message_id: 'm', source_revision: '1' },
    source_snapshot_digest: 'a'.repeat(64), execution_state: 'succeeded', invocation_state_version: '2', answer: 'answer',
    result_digest: createHash('sha256').update(JSON.stringify({ answer: 'answer', failure_code: null, state: 'succeeded' })).digest('hex'),
    target: { project_id: 'p', agent_id: 'a' }, target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
    delivery_state: 'pending', delivery_state_version: '1',
  } })
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
    receiveCollaborationDelivery: async () => { enter(); await new Promise<void>((resolve) => { release = resolve }); return {} },
  }))
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'key', pluginRoots: [] }
  try {
    await workers.start(input)
    const receiver = workers.collaborationDeliveryReceiver(input.profileId)
    const pending = receiver.receive(payload, new AbortController().signal)
    const denied = expect(pending).rejects.toMatchObject({ code: 'stale' })
    await entered
    await workers.dispose(input.profileId); await workers.start(input)
    expect(receiver.assertCurrent).toThrow()
    release(); await denied
    const current = workers.collaborationDeliveryReceiver(input.profileId)
    expect(current.assertCurrent).not.toThrow()
    await expect(current.receive(payload, AbortSignal.abort())).rejects.toThrow()
    await workers.disposeAll()
    expect(current.assertCurrent).toThrow()
  } finally { release?.(); await workers.disposeAll() }
})

it('discards full Source content after worker replacement and rejects reads after disposal or cancellation', async () => {
  const target = {
    workspace_id: '123e4567-e89b-42d3-a456-426614174000' as never,
    session_id: 'session' as never,
    source_message_id: 'message',
    source_revision: '1',
  }
  const capsule = { descriptor: { ...target, snapshot_digest: 'a'.repeat(64) }, snapshot_json: '{}' }
  let enter!: () => void,
    release!: () => void,
    generation = 0
  const started = new Promise<void>((resolve) => {
    enter = resolve
  })
  const workers = new ProfileWorkerSupervisor(async () => {
    const current = ++generation
    return {
      closeNotifications() {},
      abort() {},
      done: Promise.resolve(),
      readCollaborationSourceSnapshot: async () => {
        if (current === 1)
          await new Promise<void>((resolve) => {
            release = resolve
            enter()
          })
        return capsule
      },
    }
  })
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'key', pluginRoots: [] }
  try {
    await workers.start(input)
    const pending = workers.readCollaborationSourceSnapshot(
      input.profileId,
      target,
      new AbortController().signal,
    )
    const denied = expect(pending).rejects.toMatchObject({ code: 'stale' })
    await started
    await workers.dispose(input.profileId)
    await workers.start(input)
    release()
    await denied
    expect(
      await workers.readCollaborationSourceSnapshot(input.profileId, target, new AbortController().signal),
    ).toEqual(capsule)
    await expect(
      workers.readCollaborationSourceSnapshot(input.profileId, target, AbortSignal.abort()),
    ).rejects.toThrow()
    await workers.disposeAll()
    await expect(
      workers.readCollaborationSourceSnapshot(input.profileId, target, new AbortController().signal),
    ).rejects.toThrow()
  } finally {
    release?.()
    await workers.disposeAll()
  }
})


it('forwards remote reads only to the live Profile worker and rejects missing capabilities', async () => {
  const remoteSession = vi.fn(async () => ({ items: [] }))
  const remoteUiRead = vi.fn(async () => ({ injections: [] }))
  const supported = new ProfileWorkerSupervisor(async () => ({
    closeNotifications() {}, abort() {}, done: Promise.resolve(), remoteSession, remoteUiRead,
  }))
  const unsupported = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
  onTestFinished(async () => { await supported.disposeAll(); await unsupported.disposeAll() })
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  const command = { operation: 'session.list' as const, command_id: '123e4567-e89b-42d3-a456-426614174000' as never }
  const signal = new AbortController().signal
  const calls = (workers: ProfileWorkerSupervisor) => [
    workers.remoteSession('profile', command, signal), workers.remoteUiRead('profile', 'boot/injections', { args: {} }, signal),
  ]
  for (const result of calls(supported)) await expect(result).rejects.toMatchObject({ code: 'unavailable' })
  await supported.start(input)
  await expect(Promise.all(calls(supported))).resolves.toEqual([{ items: [] }, { injections: [] }])
  expect(remoteSession).toHaveBeenCalledWith(command, signal)
  expect(remoteUiRead).toHaveBeenCalledWith('boot/injections', { args: {} }, signal)
  await unsupported.start(input)
  for (const result of calls(unsupported)) await expect(result).rejects.toMatchObject({ code: 'unavailable' })
  await supported.disposeAll()
  for (const result of calls(supported)) await expect(result).rejects.toMatchObject({ code: 'unavailable' })
})

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


it('discards a committed Source reply after its worker is disposed or replaced', async () => {
  let release!: () => void, enter!: () => void
  const started = new Promise<void>((resolve) => { enter = resolve })
  const target = { workspace_id: '123e4567-e89b-42d3-a456-426614174000' as never, session_id: 'source-session' as never,
    source_message_id: 'message-1', source_revision: '1' }
  const descriptor = { ...target, snapshot_digest: 'a'.repeat(64) }
  let generation = 0
  const workers = new ProfileWorkerSupervisor(async () => {
    const current = ++generation
    return { closeNotifications() {}, abort() {}, done: Promise.resolve(), inspectCollaborationSource: async () => {
      if (current === 1) await new Promise<void>((resolve) => { release = resolve; enter() })
      return descriptor
    } }
  })
  const input = { profileId: 'profile', profileRoot: '/owned', credentialHandle: 'keychain:test', pluginRoots: [] }
  try {
    await workers.start(input)
    const pending = workers.inspectCollaborationSource(input.profileId, target, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'stale' })
    await started
    await workers.dispose(input.profileId)
    await workers.start(input)
    release()
    await rejected
    expect(await workers.inspectCollaborationSource(input.profileId, target, new AbortController().signal)).toEqual(descriptor)
    await expect(workers.inspectCollaborationSource(input.profileId, target, AbortSignal.abort())).rejects.toThrow()
  } finally { release?.(); await workers.disposeAll() }
})
