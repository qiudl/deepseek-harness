import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { runPnpm } from '../src/profile-import-plugin-isolated-install.ts'

const processFault = vi.hoisted(() => ({
  exit: 'success' as 'success' | 'nonzero' | 'launch' | 'manual',
  pid: undefined as number | undefined,
  child: null as EventEmitter | null,
  onSpawn: null as ((child: EventEmitter) => void) | null,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return { ...actual, spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: processFault.pid })
    processFault.child = child
    processFault.onSpawn?.(child)
    processFault.onSpawn = null
    if (processFault.exit === 'success') queueMicrotask(() => child.emit('close', 0))
    if (processFault.exit === 'nonzero') queueMicrotask(() => child.emit('close', 1))
    if (processFault.exit === 'launch') queueMicrotask(() => {
      child.emit('error', Error('spawn failed'))
      child.emit('close', null)
    })
    return child
  } }
})

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-pnpm-process-'))
  onTestFinished(async () => {
    processFault.exit = 'success'
    processFault.pid = undefined
    processFault.child = null
    processFault.onSpawn = null
    vi.restoreAllMocks()
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })
  const pnpmEntrypointPath = join(root, 'pnpm.cjs')
  const sandboxRoot = join(root, 'sandbox')
  await writeFile(pnpmEntrypointPath, '', { mode: 0o600 })
  await mkdir(sandboxRoot, { mode: 0o700 })
  return { nodeExecutablePath: process.execPath, pnpmEntrypointPath, sandboxRoot }
}

async function spawnedChild(): Promise<EventEmitter> {
  if (processFault.child) return processFault.child
  return new Promise((resolve) => { processFault.onSpawn = resolve })
}

describe.skipIf(process.platform === 'win32')('isolated Profile import pnpm process policy', () => {
  it('rejects this POSIX-only installer on Windows', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await expect(runPnpm({ nodeExecutablePath: 'node', pnpmEntrypointPath: 'pnpm',
        sandboxRoot: 'sandbox' })).rejects.toThrow('profile_import_plugin_isolated_platform_unsupported')
    } finally { Object.defineProperty(process, 'platform', descriptor) }
  })

  it('rejects missing, relative, and non-file binaries before spawn', async () => {
    const input = await sandbox()
    await expect(runPnpm({ ...input, nodeExecutablePath: 'node' }))
      .rejects.toThrow('profile_import_plugin_isolated_binary_invalid')
    await expect(runPnpm({ ...input, pnpmEntrypointPath: input.sandboxRoot }))
      .rejects.toThrow('profile_import_plugin_isolated_binary_invalid')
    await expect(runPnpm({ ...input, pnpmEntrypointPath: join(input.sandboxRoot, 'missing') }))
      .rejects.toThrow()
    expect(processFault.child).toBeNull()
  })

  it('treats an already cancelled install as cancelled before spawn', async () => {
    const input = await sandbox()
    const controller = new AbortController()
    controller.abort()
    await expect(runPnpm({ ...input, signal: controller.signal })).rejects.toThrow()
    expect(processFault.child).toBeNull()
  })

  it.each([['success', false], ['nonzero', true], ['launch', true]] as const)
  ('handles a pnpm child %s result', async (exit, rejects) => {
    const input = await sandbox()
    processFault.exit = exit
    const call = runPnpm({ ...input, lockfileOnly: true, frozen: true })
    if (rejects) await expect(call).rejects.toThrow(exit === 'launch'
      ? 'profile_import_plugin_isolated_launch_failed' : 'profile_import_plugin_isolated_install_failed')
    else await expect(call).resolves.toBeUndefined()
  })

  it('stops an in-flight install on cancellation and waits for child close', async () => {
    const input = await sandbox()
    processFault.exit = 'manual'
    processFault.pid = 42
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const controller = new AbortController()
    const call = runPnpm({ ...input, signal: controller.signal })
    const child = await spawnedChild()
    controller.abort()
    child.emit('close', null)
    await expect(call).rejects.toThrow('profile_import_plugin_isolated_cancelled')
    expect(kill).toHaveBeenCalledWith(-42, 'SIGTERM')
  })

  it('cancels safely when the child has no pid or has already exited', async () => {
    const input = await sandbox()
    processFault.exit = 'manual'
    const controller = new AbortController()
    const call = runPnpm({ ...input, signal: controller.signal })
    const child = await spawnedChild()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Error('already exited') })
    controller.abort()
    controller.abort()
    child.emit('close', null)
    await expect(call).rejects.toThrow('profile_import_plugin_isolated_cancelled')
    expect(kill).not.toHaveBeenCalled()

    processFault.pid = 44
    processFault.child = null
    const secondController = new AbortController()
    const second = runPnpm({ ...input, signal: secondController.signal })
    const secondChild = await spawnedChild()
    secondController.abort()
    secondChild.emit('close', null)
    await expect(second).rejects.toThrow('profile_import_plugin_isolated_cancelled')
    expect(kill).toHaveBeenCalledWith(-44, 'SIGTERM')
  })

  it('times out a child and rejects when it eventually closes', async () => {
    const input = await sandbox()
    processFault.exit = 'manual'
    processFault.pid = 43
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const call = runPnpm(input)
    const child = await spawnedChild()
    await vi.advanceTimersByTimeAsync(122_000)
    child.emit('close', null)
    await expect(call).rejects.toThrow('profile_import_plugin_isolated_timeout')
    expect(kill).toHaveBeenCalledWith(-43, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-43, 'SIGKILL')
  })

  it('keeps the first stop reason if the deadline fires after cancellation', async () => {
    const input = await sandbox()
    processFault.exit = 'manual'
    processFault.pid = 45
    vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const call = runPnpm({ ...input, signal: controller.signal })
    const child = await spawnedChild()
    controller.abort()
    await vi.advanceTimersByTimeAsync(120_000)
    child.emit('close', null)
    await expect(call).rejects.toThrow('profile_import_plugin_isolated_cancelled')
  })
})
