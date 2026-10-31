import { afterEach, expect, it, vi } from 'vitest'
import { waitForPluginRuntime } from '../src/plugin-runtime-ack.ts'
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
