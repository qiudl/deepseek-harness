import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { runProfilePluginCommand } from '../src/plugin-command.ts'
import type { WindowsHostPrivatePathEvidence } from '../src/windows-host-registration.ts'

const commands = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:child_process', () => commands)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); commands.spawn.mockReset(); commands.spawnSync.mockReset() })
const sid = 'S-1-5-21-1000-2000-3000-1001'
function evidence(kind: 'file' | 'directory'): WindowsHostPrivatePathEvidence {
  return { kind, reparsePoint: false, linkCount: 1, ownerSid: sid, daclProtected: true,
    access: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(principal => ({ sid: principal, type: 'allow',
      mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true })) }
}
function fixture() {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  onTestFinished(() => { Object.defineProperty(process, 'platform', platform) })
  const root = mkdtempSync(join(tmpdir(), 'windows-plugin-adapter-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const control = join(root, 'control'); mkdirSync(control)
  const binary = join(root, 'node.exe'); writeFileSync(binary, '')
  let policy: string | undefined
  const bindings = {
    inspectExistingDirectory: vi.fn(() => evidence('directory')),
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn(() => policy === undefined ? undefined : { contents: Buffer.from(policy), evidence: evidence('file') }),
    replacePrivateFile: vi.fn((_path: string, contents: Buffer) => { policy = contents.toString(); return evidence('file') }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  }
  const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough() })
  commands.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('close', 0)); return child })
  commands.spawnSync.mockReturnValue({ status: 0 })
  const request = { nodeExecutablePath: binary, dshEntrypointPath: binary, pnpmEntrypointPath: binary,
    profileRoot: root, controlRoot: control, uid: 0, windows: { userSid: sid, bindings },
    spec: 'fixture@1.0.0', signal: new AbortController().signal, guard() {} }
  return { request, child, control, bindings, setPolicy(value: string) { policy = value }, policy: () => policy }
}
it.each([undefined, 'D:\\Windows'])('builds a private cmd shim and scrubbed environment with SystemRoot %s', async (systemRoot) => {
  const f = fixture(); vi.stubEnv('SystemRoot', systemRoot)
  let shim = ''
  commands.spawn.mockImplementation((_binary: string, _args: string[], options: { env: { PATH: string } }) => {
    shim = readFileSync(join(options.env.PATH.split(';')[0]!, 'pnpm.cmd'), 'utf8')
    queueMicrotask(() => f.child.emit('close', 0)); return f.child
  })
  await runProfilePluginCommand(f.request)
  expect(shim).toBe(`@echo off\r\n"${f.request.nodeExecutablePath}" "${f.request.pnpmEntrypointPath}" %*\r\n`)
  expect(commands.spawn).toHaveBeenCalledWith(f.request.nodeExecutablePath, expect.any(Array), expect.objectContaining({
    detached: false, shell: false, windowsHide: true,
    env: expect.objectContaining({ SystemRoot: systemRoot ?? 'C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', CI: '1' }) as object,
  }))
  expect(readdirSync(f.control)).toEqual([])
})
it('publishes only valid exact build approvals through native ACL bindings', async () => {
  const f = fixture(); const request = { ...f.request, allowBuild: f.request.spec }
  await expect(runProfilePluginCommand(request)).rejects.toThrow('unsafe_plugin_policy')
  f.setPolicy('allowBuilds: ['); await expect(runProfilePluginCommand(request)).rejects.toThrow('invalid_plugin_policy')
  f.setPolicy('allowBuilds:\n  fixture@1.0.0: false\n')
  await expect(runProfilePluginCommand(request)).rejects.toThrow('build_policy_conflict')
  expect(commands.spawn).not.toHaveBeenCalled()
  f.setPolicy('allowBuilds: {}\n')
  await runProfilePluginCommand(request)
  expect(f.policy()).toContain('fixture@1.0.0: true')
  await runProfilePluginCommand(request)
  expect(f.bindings.replacePrivateFile).toHaveBeenCalledTimes(2)
  expect(readdirSync(f.control)).toEqual([])
})
it('rejects cmd metacharacters in host binary paths before execution', async () => {
  const f = fixture()
  for (const character of ['"', '%', '&', '|', '<', '>', '^']) {
    await expect(runProfilePluginCommand({ ...f.request, pnpmEntrypointPath: f.request.pnpmEntrypointPath + character }))
      .rejects.toThrow('invalid_plugin_binary')
  }
  expect(commands.spawn).not.toHaveBeenCalled()
})
it.each([false, true])('cancels the Windows process tree and reports taskkill failure=%s', async (failure) => {
  const f = fixture(); const controller = new AbortController()
  commands.spawn.mockImplementation(() => {
    queueMicrotask(() => { controller.abort(); f.child.emit('close', 1) }); return f.child
  })
  commands.spawnSync.mockReturnValue(failure ? { error: Error('missing taskkill') } : { status: 128 })
  await expect(runProfilePluginCommand({ ...f.request, signal: controller.signal }))
    .rejects.toThrow(failure ? 'plugin_termination_failed' : 'plugin_install_cancelled')
  expect(commands.spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '42', '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  expect(readdirSync(f.control)).toEqual([])
})
