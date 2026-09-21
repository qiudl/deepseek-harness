import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectPluginScripts } from '../src/plugin-script-preflight.ts'

const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
}))

afterEach(() => { vi.unstubAllGlobals() })

describe('plugin script zero-write preflight', () => {
  it('returns only lifecycle scripts and binds their exact commands to an immutable digest', async () => {
    const requests: string[] = []
    const result = await inspectPluginScripts({ packageName: '@fixture/demo', spec: '@fixture/demo@1.2.3',
      fetchFn: async (input) => { requests.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return reply({ name: '@fixture/demo', version: '1.2.3',
        scripts: { test: 'vitest', preinstall: 'node pre.cjs', postinstall: 'node post.cjs' } }) } })
    expect(requests).toEqual(['https://registry.npmjs.org/%40fixture%2Fdemo/1.2.3'])
    expect(result).toMatchObject({ buildKey: '@fixture/demo@1.2.3', scripts: [
      { name: 'preinstall', command: 'node pre.cjs' }, { name: 'postinstall', command: 'node post.cjs' },
    ] })
    expect(result?.digest).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('reads an exact GitHub commit and rejects manifest identity drift', async () => {
    await expect(inspectPluginScripts({ packageName: 'demo', spec: `github:owner/repo#${'a'.repeat(40)}`,
      fetchFn: async () => reply({ name: 'other', version: '1.0.0', scripts: { prepare: 'node build.js' } }) }))
      .rejects.toThrow('plugin_preflight_mismatch')
  })

  it('reads a GitHub manifest through the default fetch with cancellation attached', async () => {
    const fetchManifest = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      name: 'demo', version: '1.0.0',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchManifest)
    const signal = new AbortController().signal
    await expect(inspectPluginScripts({ packageName: 'demo',
      spec: `github:owner/repo#${'a'.repeat(40)}`, signal })).resolves.toBeUndefined()
    expect(fetchManifest).toHaveBeenCalledWith(
      `https://raw.githubusercontent.com/owner/repo/${'a'.repeat(40)}/package.json`,
      expect.objectContaining({ signal }),
    )
  })

  it('needs no approval when the immutable manifest has no lifecycle script', async () => {
    await expect(inspectPluginScripts({ packageName: 'demo', spec: 'demo@1.0.0',
      fetchFn: async () => reply({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest' } }) }))
      .resolves.toBeUndefined()
  })

  it.each([
    ['mutable source', { packageName: 'demo', spec: 'demo@latest' }, undefined, 'invalid_plugin_input'],
    ['failed response', { packageName: 'demo', spec: 'demo@1.0.0' }, new Response('{}', { status: 500 }), 'plugin_preflight_failed'],
    ['oversized declared response', { packageName: 'demo', spec: 'demo@1.0.0' }, new Response('{}', {
      status: 200, headers: { 'content-length': '1048577' },
    }), 'plugin_preflight_failed'],
    ['invalid declared response length', { packageName: 'demo', spec: 'demo@1.0.0' }, new Response('{}', {
      status: 200, headers: { 'content-length': '1.5' },
    }), 'plugin_preflight_failed'],
    ['empty response', { packageName: 'demo', spec: 'demo@1.0.0' }, new Response('', { status: 200 }), 'plugin_preflight_failed'],
    ['primitive manifest', { packageName: 'demo', spec: 'demo@1.0.0' }, new Response('null', { status: 200 }), 'plugin_preflight_failed'],
    ['array manifest', { packageName: 'demo', spec: 'demo@1.0.0' }, new Response('[]', { status: 200 }), 'plugin_preflight_failed'],
  ] as const)('rejects %s', async (_name, input, response, reason) => {
    await expect(inspectPluginScripts({ ...input,
      ...(response === undefined ? {} : { fetchFn: async () => response }) })).rejects.toThrow(reason)
  })

  it.each([
    ['wrong name', { name: 'other', version: '1.0.0' }, 'plugin_preflight_mismatch'],
    ['missing version', { name: 'demo' }, 'plugin_preflight_mismatch'],
    ['invalid version', { name: 'demo', version: 'latest' }, 'plugin_preflight_mismatch'],
    ['version drift', { name: 'demo', version: '2.0.0' }, 'plugin_preflight_mismatch'],
    ['null scripts', { name: 'demo', version: '1.0.0', scripts: null }, 'plugin_preflight_failed'],
    ['array scripts', { name: 'demo', version: '1.0.0', scripts: [] }, 'plugin_preflight_failed'],
    ['non-string command', { name: 'demo', version: '1.0.0', scripts: { install: 1 } }, 'plugin_preflight_failed'],
    ['empty command', { name: 'demo', version: '1.0.0', scripts: { install: '' } }, 'plugin_preflight_failed'],
    ['oversized command', { name: 'demo', version: '1.0.0', scripts: { install: 'x'.repeat(4097) } }, 'plugin_preflight_failed'],
    ['control command', { name: 'demo', version: '1.0.0', scripts: { install: 'x\u0000' } }, 'plugin_preflight_failed'],
  ] as const)('rejects a manifest with %s', async (_name, body, reason) => {
    await expect(inspectPluginScripts({ packageName: 'demo', spec: 'demo@1.0.0',
      fetchFn: async () => reply(body) })).rejects.toThrow(reason)
  })
})
