import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

const launch = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async load => ({
  ...await load<typeof import('node:child_process')>(), spawn: launch,
}))

import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import { RESTRICTED_WORKER_PARENT_MONITOR } from '../src/restricted-worker-parent-monitor.ts'

it.skipIf(process.platform === 'win32')('launches restricted history under the macOS sandbox with no inherited Profile environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restricted-launch-'))
  const previous = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!previous) throw new Error('missing process platform descriptor')
  const child = Object.assign(new EventEmitter(), { pid: undefined, kill: vi.fn(() => true) })
  launch.mockReturnValueOnce(child)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  onTestFinished(async () => { Object.defineProperty(process, 'platform', previous); launch.mockReset(); await rm(root, { recursive: true, force: true }) })
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: '/fixture/node', dshEntrypointPath: '/fixture/dsh' })
  await expect(factory.createRestricted({ profileId: 'fixture', profileRoot: root, credentialHandle: 'opaque',
    pluginRoots: [], env: {} })).rejects.toMatchObject({ code: 'unavailable' })
  expect(launch).toHaveBeenCalledOnce()
  const [command, args, options] = launch.mock.calls[0] as [string, string[], { env: Record<string, string>; stdio: string[] }]
  expect(command).toBe('/usr/bin/sandbox-exec')
  expect(args).toEqual(expect.arrayContaining(['-p', '/fixture/node', '--import', RESTRICTED_WORKER_PARENT_MONITOR, '/fixture/dsh']))
  expect(args[1]).toContain('(deny process-fork)')
  expect(args[1]).toContain('(deny network-outbound)')
  expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc'])
  expect(options.env.DSH_PROFILE_PLUGIN_ROOTS).toBe('[]')
  expect(options.env).not.toHaveProperty('NODE_OPTIONS')
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
})
