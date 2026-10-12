import { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { runProfilePluginCommand } from '../src/plugin-command.ts'
import type { WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'

const native = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: native.spawn, spawnSync: native.kill,
}))
const sid = 'S-1-5-21-1000-2000-3000-1001'
function evidence(kind: 'file' | 'directory'): WindowsHostPrivatePathEvidence {
  return { kind, reparsePoint: false, linkCount: 1, ownerSid: sid, daclProtected: true,
    access: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(value => ({ sid: value, type: 'allow',
      mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true })) }
}
function fixture() {
  vi.stubGlobal('process', new Proxy(process, { get: (target, key): unknown => key === 'platform' ? 'win32' : Reflect.get(target, key) }))
  const root = mkdtempSync(join(tmpdir(), 'windows-command-adapter-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const profile = join(root, 'profile'), control = join(root, 'control')
  mkdirSync(profile); mkdirSync(control)
  const cli = join(root, 'cli.cjs'), pnpm = join(root, 'pnpm.cjs')
  writeFileSync(cli, ''); writeFileSync(pnpm, '')
  const child = new ChildProcess()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  Object.defineProperty(child, 'pid', { value: 123 })
  native.spawn.mockImplementation(() => { queueMicrotask(() => { child.emit('close', 0) }); return child })
  native.kill.mockReturnValue({ status: 0 })
  const bindings = {
    inspectExistingDirectory: vi.fn(() => evidence('directory')),
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>(() => ({ contents: Buffer.from('allowBuilds: {}\n'), evidence: evidence('file') })),
    replacePrivateFile: vi.fn(() => evidence('file')),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize() {}, release() {} })),
  }
  const controller = new AbortController()
  return { profile, control, cli, pnpm, child, bindings, controller,
    input: { nodeExecutablePath: process.execPath, dshEntrypointPath: cli, pnpmEntrypointPath: pnpm,
      profileRoot: profile, controlRoot: control, uid: 0, spec: 'bundle@1.2.3',
      signal: controller.signal, guard() {}, windows: { userSid: sid, bindings } } }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); native.spawn.mockReset(); native.kill.mockReset() })
it('launches a scrubbed Windows command through a private cmd shim and native build policy', async () => {
  const f = fixture()
  let shim = ''
  native.spawn.mockImplementation((_command: string, _args: string[], options: { env: Record<string, string> }) => {
    shim = readFileSync(join(options.env.PATH!.split(';')[0]!, 'pnpm.cmd'), 'utf8')
    expect(options.env).not.toHaveProperty('ADAPTER_SECRET')
    queueMicrotask(() => { f.child.emit('close', 0) }); return f.child
  })
  vi.stubEnv('ADAPTER_SECRET', 'private')
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  await runProfilePluginCommand({ ...f.input, allowBuild: 'bundle@1.2.3' })
  expect(shim).toContain(`"${f.pnpm}" %*`)
  expect(f.bindings.replacePrivateFile).toHaveBeenCalledWith(join(f.profile, 'pnpm-workspace.yaml'),
    expect.any(Buffer), expect.stringContaining('D:P'))
})
it('rejects missing, malformed and conflicting Windows build policies before spawn', async () => {
  const f = fixture()
  f.bindings.readPrivateFile.mockReturnValueOnce(undefined)
  await expect(runProfilePluginCommand({ ...f.input, allowBuild: 'bundle@1.2.3' })).rejects.toThrow('unsafe_plugin_policy')
  for (const [text, error] of [['[', 'invalid_plugin_policy'], ['allowBuilds:\n  "bundle@1.2.3": false', 'build_policy_conflict']]) {
    f.bindings.readPrivateFile.mockReturnValueOnce({ contents: Buffer.from(text!), evidence: evidence('file') })
    await expect(runProfilePluginCommand({ ...f.input, allowBuild: 'bundle@1.2.3' })).rejects.toThrow(error)
  }
  expect(native.spawn).not.toHaveBeenCalled()
})
it('rejects shell metacharacters in pinned binaries and accepts a Profile-owned bundled archive', async () => {
  const f = fixture()
  await expect(runProfilePluginCommand({ ...f.input, pnpmEntrypointPath: `${f.pnpm}%` })).rejects.toThrow('invalid_plugin_binary')
  const directory = join(f.profile, 'profiles', 'web', '.bundled-plugins')
  mkdirSync(directory, { recursive: true })
  const archivePath = join(directory, `${'a'.repeat(64)}.tgz`); writeFileSync(archivePath, 'archive')
  await runProfilePluginCommand({ ...f.input, spec: 'bundled:bundle@1.2.3', archivePath })
})
it.each([false, true])('cancels the entire Windows installer tree and reports taskkill errors (failure=%s)', async (fail) => {
  const f = fixture()
  native.spawn.mockImplementation(() => { queueMicrotask(() => { f.controller.abort() }); return f.child })
  native.kill.mockImplementation(() => {
    queueMicrotask(() => { f.child.emit('close', 1) })
    return fail ? { error: Error('taskkill unavailable') } : { status: 128 }
  })
  await expect(runProfilePluginCommand(f.input)).rejects.toThrow(fail ? 'plugin_termination_failed' : 'plugin_install_cancelled')
  expect(native.kill).toHaveBeenCalledWith('taskkill', ['/PID', '123', '/T', '/F'], expect.objectContaining({ windowsHide: true }))
})
