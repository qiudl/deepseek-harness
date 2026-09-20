import { describe, expect, it } from 'vitest'
import { inspectPluginScripts } from '../src/plugin-script-preflight.ts'

const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
}))

describe('plugin script zero-write preflight', () => {
  it('returns only lifecycle scripts and binds their exact commands to an immutable digest', async () => {
    const requests: string[] = []
    const result = await inspectPluginScripts({ packageName: '@fixture/demo', spec: '@fixture/demo@1.2.3',
      fetchFn: async (input) => { requests.push(String(input)); return reply({ name: '@fixture/demo', version: '1.2.3',
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

  it('needs no approval when the immutable manifest has no lifecycle script', async () => {
    await expect(inspectPluginScripts({ packageName: 'demo', spec: 'demo@1.0.0',
      fetchFn: async () => reply({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest' } }) }))
      .resolves.toBeUndefined()
  })
})
