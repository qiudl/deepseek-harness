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
