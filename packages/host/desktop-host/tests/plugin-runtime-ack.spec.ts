import { afterEach, expect, it, vi } from 'vitest'
import { waitForPluginRuntime } from '../src/plugin-runtime-ack.ts'
import { createPluginRuntimeAcknowledgements } from '../src/plugin-runtime-acknowledgements.ts'
const worker = { origin: 'http://127.0.0.1:12345', bootstrapCookie: { name: 'fixture', value: 'private' } }
const expected = [{ entryId: 'demo', moduleName: '@fixture/plugin' }]
afterEach(() => { vi.unstubAllGlobals() })
function response(entries: unknown[]) {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ cookie: 'fixture=private' })
    if (typeof init.body !== 'string') throw Error('missing request body')
    const request = JSON.parse(init.body) as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { entries } } })
  })
}
it('acknowledges only the enabled active row with the exact module identity', async () => {
  response([{ ...expected[0], enabled: true, fiberPhase: 'active' }])
  await expect(waitForPluginRuntime(worker, expected, new AbortController().signal)).resolves.toBeUndefined()
})
it('does not mistake another module or a disabled row for an active installation', async () => {
  for (const change of [{ moduleName: '@other/plugin' }, { enabled: false }]) {
    response([{ ...expected[0], enabled: true, fiberPhase: 'active', ...change }])
    await expect(waitForPluginRuntime(worker, expected, AbortSignal.timeout(30))).rejects.toThrow()
  }
})
it('rejects failed and duplicate runtime identities', async () => {
  response([{ ...expected[0], enabled: true, fiberPhase: 'failed' }])
  await expect(waitForPluginRuntime(worker, expected, new AbortController().signal)).rejects.toThrow('plugin_startup_failed')
  response([{ ...expected[0], enabled: true, fiberPhase: 'active' }, { ...expected[0], enabled: true, fiberPhase: 'failed' }])
  await expect(waitForPluginRuntime(worker, expected, new AbortController().signal)).rejects.toThrow('invalid_runtime_response')
})
it('confirms deactivation only when the exact disabled row has no running fiber', async () => {
  response([{ ...expected[0], enabled: false, fiberPhase: null }])
  await expect(waitForPluginRuntime(worker, [], new AbortController().signal, [], expected)).resolves.toBeUndefined()
  for (const entries of [[], [{ ...expected[0], enabled: false, fiberPhase: 'active' }],
    [{ ...expected[0], enabled: false, fiberPhase: null, moduleName: 'other' }]]) {
    response(entries)
    await expect(waitForPluginRuntime(worker, [], AbortSignal.timeout(30), [], expected)).rejects.toThrow()
  }
})

it.each([null, 42, {}, { type: 'client-request' }, { type: 'server-response', rpcId: 'wrong', result: { ok: true, value: { entries: [] } } }])('rejects malformed inventory envelopes: %#', async (value) => {
  vi.stubGlobal('fetch', async () => Response.json(value))
  await expect(waitForPluginRuntime(worker, expected, new AbortController().signal)).rejects.toThrow('invalid_runtime_response')
})

it.each([401, 204])('refuses HTTP %s without acknowledging startup', async (status) => {
  vi.stubGlobal('fetch', async () => new Response(null, { status }))
  await expect(waitForPluginRuntime(worker, expected, new AbortController().signal)).rejects.toThrow('runtime_unavailable')
})

it('cancels an error response body and rejects excessive response bytes', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ cancel }), { status: 503 }))
  await expect(waitForPluginRuntime(worker, expected, new AbortController().signal)).rejects.toThrow('runtime_unavailable')
  expect(cancel).toHaveBeenCalledOnce()
  vi.stubGlobal('fetch', async () => new Response('x'.repeat(524_289)))
  await expect(waitForPluginRuntime(worker, expected, new AbortController().signal)).rejects.toThrow('runtime_response_too_large')
})

it('rejects duplicate disabled identities instead of confirming deactivation', async () => {
  const row = { ...expected[0], enabled: false, fiberPhase: null }
  response([row, row])
  await expect(waitForPluginRuntime(worker, [], new AbortController().signal, [], expected)).rejects.toThrow('invalid_runtime_response')
})

it('waits for actual disappearance of removed entries while ignoring unrelated metadata', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    if (typeof init.body !== 'string') throw new Error('expected string request body')
    const { rpcId } = JSON.parse(init.body) as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: {
      entries: fetcher.mock.calls.length === 1 ? [null, 42, { entryId: 'other' }, { entryId: 'removed' }] : [null, 42, { entryId: 'other' }],
    } } })
  })
  vi.stubGlobal('fetch', fetcher)
  await expect(waitForPluginRuntime(worker, [], new AbortController().signal, ['removed'])).resolves.toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

function acknowledgementFixture() {
  const profile = { profileId: 'profile' as import('../src/types.ts').PersonProfileRecord['profileId'],
    kind: 'local-anonymous' as const, personIndex: 'fixture', keyHandle: 'key', unlockVerifier: null,
    bindingGeneration: 1, createdAt: 0 }
  const workers = { dispose: vi.fn(async () => {}), activate: vi.fn(async () => worker) }
  const ensureWorker = vi.fn(async () => {})
  const resolve = vi.fn(() => profile)
  const controller = new AbortController()
  const context = { kind: 'plugin' as const, signal: controller.signal, guard: vi.fn() }
  const callbacks = createPluginRuntimeAcknowledgements({ workers, ensureWorker,
    requiredProfile: resolve, expected: () => expected })
  return { profile, workers, ensureWorker, resolve, controller, context, callbacks }
}
it.each(['removal', 'toggle', 'installation'] as const)('reloads the selected worker before acknowledging %s', async (action) => {
  const f = acknowledgementFixture()
  response(action === 'removal' ? [] : [{ ...expected[0], enabled: true, fiberPhase: 'active' }])
  if (action === 'removal') await f.callbacks.acknowledgeRemoval('profile', ['removed'], f.context)
  else if (action === 'toggle') await f.callbacks.acknowledgeToggle('profile',
    { patch: '[]', previousExpected: [], previousDisabled: [], expected, disabled: [] }, f.context)
  else await f.callbacks.acknowledge('profile', '@fixture/plugin', f.context)
  expect(f.resolve).toHaveBeenCalledWith('profile')
  expect(f.ensureWorker).toHaveBeenCalledWith(f.profile)
  expect(f.workers.dispose.mock.invocationCallOrder[0]).toBeLessThan(f.ensureWorker.mock.invocationCallOrder[0]!)
  expect(f.ensureWorker.mock.invocationCallOrder[0]).toBeLessThan(f.workers.activate.mock.invocationCallOrder[0]!)
  expect(f.context.guard).toHaveBeenCalledTimes(3)
})
it.each(['dispose', 'prepare'] as const)('refuses installation acknowledgement when authority is revoked after %s', async (phase) => {
  const f = acknowledgementFixture()
  const revoke = async () => { f.context.guard.mockImplementation(() => { throw Error('revoked') }) }
  if (phase === 'dispose') f.workers.dispose.mockImplementation(revoke)
  else f.ensureWorker.mockImplementation(revoke)
  await expect(f.callbacks.acknowledge('profile', '@fixture/plugin', f.context)).rejects.toThrow('revoked')
  expect(f.workers.activate).not.toHaveBeenCalled()
})
it('does not prepare or activate after a cancelled toggle disposal', async () => {
  const f = acknowledgementFixture()
  f.workers.dispose.mockImplementation(async () => { f.controller.abort() })
  await expect(f.callbacks.acknowledgeToggle('profile',
    { patch: '[]', previousExpected: [], previousDisabled: [], expected, disabled: [] }, f.context)).rejects.toThrow()
  expect(f.ensureWorker).not.toHaveBeenCalled()
  expect(f.workers.activate).not.toHaveBeenCalled()
})
