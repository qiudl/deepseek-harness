import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as pause } from 'node:timers/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { runProfilePluginCommand } from '../src/plugin-command.ts'

const fsFaults = vi.hoisted(() => ({ failPolicyRename: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const renameSync: typeof actual.renameSync = (oldPath, newPath) => {
    if (fsFaults.failPolicyRename) throw Object.assign(Error('rename failed'), { code: 'EIO' })
    actual.renameSync(oldPath, newPath)
  }
  return { ...actual, renameSync }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-plugin 'command-"))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const profile = join(root, 'profile'); const control = join(root, 'control')
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(control, { mode: 0o700 })
  const cli = join(root, 'cli.cjs'); const pnpm = join(root, 'pnpm.cjs')
  writeFileSync(cli, "const {spawnSync}=require('node:child_process');const r=spawnSync('pnpm', process.argv.slice(5),{stdio:'inherit'});process.exit(r.status??1)")
  writeFileSync(pnpm, "require('node:fs').writeFileSync(process.env.DSH_HOME+'/observed.json',"
    + 'JSON.stringify({args:process.argv.slice(2),home:process.env.DSH_HOME,secret:process.env.PLUGIN_TEST_SECRET}));')
  return { root, profile, control, cli, pnpm, options: { nodeExecutablePath: process.execPath,
    dshEntrypointPath: cli, pnpmEntrypointPath: pnpm, profileRoot: profile, controlRoot: control, uid: process.getuid!() } }
}
it('runs the pinned CLI and pnpm under the selected Profile without ambient credentials or build scripts', async () => {
  const f = fixture()
  const originalSecret = process.env.PLUGIN_TEST_SECRET
  process.env.PLUGIN_TEST_SECRET = 'must-not-be-forwarded'
  onTestFinished(() => {
    if (originalSecret === undefined) delete process.env.PLUGIN_TEST_SECRET
    else process.env.PLUGIN_TEST_SECRET = originalSecret
  })
  await runProfilePluginCommand({ ...f.options, spec: '@fixture/bundle@1.2.3', signal: new AbortController().signal, guard() {} })
  expect(readdirSync(f.control)).toEqual([])
  expect(JSON.parse(readFileSync(join(f.profile, 'observed.json'), 'utf8'))).toEqual({ args: ['add', '@fixture/bundle@1.2.3', '--save-exact', '--ignore-scripts'], home: f.profile })
})
it('runs scripts only after persisting the exact version approval', async () => {
  const f = fixture()
  writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'packages:\n  - profiles/*\nallowBuilds:\n  unrelated: false\n', { mode: 0o600 })
  await runProfilePluginCommand({ ...f.options, spec: '@fixture/bundle@1.2.3', allowBuild: '@fixture/bundle@1.2.3',
    signal: new AbortController().signal, guard() {} })
  expect(JSON.parse(readFileSync(join(f.profile, 'observed.json'), 'utf8')))
    .toMatchObject({ args: ['add', '@fixture/bundle@1.2.3', '--save-exact'] })
  expect(readFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'utf8')).toContain('"@fixture/bundle@1.2.3": true')
  expect(readFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'utf8')).toContain('unrelated: false')
})
it('rejects invalid or mismatched build approvals before package execution', async () => {
  const f = fixture()
  writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'packages: []\nallowBuilds: {}\n', { mode: 0o600 })
  const request = { ...f.options, spec: '@fixture/bundle@1.2.3', signal: new AbortController().signal, guard() {} }
  await expect(runProfilePluginCommand({ ...request, allowBuild: '@fixture/bundle@latest' }))
    .rejects.toThrow('invalid_build_approval')
  await expect(runProfilePluginCommand({ ...request, allowBuild: '@fixture/other@1.2.3' }))
    .rejects.toThrow('invalid_build_approval')
  await expect(runProfilePluginCommand({ ...request, action: 'remove', spec: '@fixture/bundle',
    allowBuild: '@fixture/bundle@1.2.3' })).rejects.toThrow('invalid_build_approval')
})
it('rejects malformed, conflicting, and unsafe build policy files', async () => {
  const signal = new AbortController().signal
  const run = async (profile: string, options: ReturnType<typeof fixture>['options']) => runProfilePluginCommand({
    ...options, profileRoot: profile, spec: '@fixture/bundle@1.2.3', allowBuild: '@fixture/bundle@1.2.3', signal, guard() {},
  })

  const malformed = fixture()
  writeFileSync(join(malformed.profile, 'pnpm-workspace.yaml'), 'allowBuilds: [\n', { mode: 0o600 })
  await expect(run(malformed.profile, malformed.options)).rejects.toThrow('invalid_plugin_policy')

  const conflict = fixture()
  writeFileSync(join(conflict.profile, 'pnpm-workspace.yaml'), 'allowBuilds:\n  "@fixture/bundle@1.2.3": false\n', { mode: 0o600 })
  await expect(run(conflict.profile, conflict.options)).rejects.toThrow('build_policy_conflict')

  const writable = fixture()
  writeFileSync(join(writable.profile, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n', { mode: 0o600 })
  chmodSync(join(writable.profile, 'pnpm-workspace.yaml'), 0o622)
  await expect(run(writable.profile, writable.options)).rejects.toThrow('unsafe_plugin_policy')

  const directory = fixture()
  mkdirSync(join(directory.profile, 'pnpm-workspace.yaml'))
  await expect(run(directory.profile, directory.options)).rejects.toThrow('unsafe_plugin_policy')

  const linked = fixture()
  const target = join(linked.profile, 'policy-target.yaml')
  writeFileSync(target, 'allowBuilds: {}\n', { mode: 0o600 })
  symlinkSync(target, join(linked.profile, 'pnpm-workspace.yaml'))
  await expect(run(linked.profile, linked.options)).rejects.toThrow('unsafe_plugin_policy')
})
it('removes a temporary build policy when atomic publication fails', async () => {
  const f = fixture()
  writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n', { mode: 0o600 })
  fsFaults.failPolicyRename = true
  onTestFinished(() => { fsFaults.failPolicyRename = false })
  await expect(runProfilePluginCommand({ ...f.options, spec: '@fixture/bundle@1.2.3',
    allowBuild: '@fixture/bundle@1.2.3', signal: new AbortController().signal, guard() {} }))
    .rejects.toThrow('rename failed')
  expect(readdirSync(f.profile)).toEqual(['pnpm-workspace.yaml'])
})
it('rejects mutable specs and revocation before launching', async () => {
  const f = fixture()
  for (const spec of ['bundle@latest', '../local', '--ignore-scripts', 'github:owner/repo#main']) {
    await expect(runProfilePluginCommand({ ...f.options, spec, signal: new AbortController().signal, guard() {} })).rejects.toThrow()
  }
  await expect(runProfilePluginCommand({ ...f.options, spec: 'bundle@1.0.0', signal: new AbortController().signal, guard() { throw Error('revoked') } }))
    .rejects.toThrow('plugin_authority_revoked')
})
it('rejects unsafe Profile directories and executable paths before launching', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const request = { ...f.options, spec: 'bundle@1.0.0', signal, guard() {} }
  await expect(runProfilePluginCommand({ ...request, profileRoot: 'relative' })).rejects.toThrow('unsafe_plugin_directory')
  chmodSync(f.profile, 0o722)
  await expect(runProfilePluginCommand(request)).rejects.toThrow('unsafe_plugin_directory')
  chmodSync(f.profile, 0o700)
  await expect(runProfilePluginCommand({ ...request, nodeExecutablePath: 'node' })).rejects.toThrow('invalid_plugin_binary')
  await expect(runProfilePluginCommand({ ...request, dshEntrypointPath: f.profile })).rejects.toThrow('invalid_plugin_binary')
  await expect(runProfilePluginCommand({ ...request, pnpmEntrypointPath: `${f.pnpm}\n` })).rejects.toThrow('invalid_plugin_binary')
})
it('reports launch, exit, and post-install authority failures without leaving its shim', async () => {
  const failedExit = fixture()
  writeFileSync(failedExit.pnpm, 'process.exit(3)')
  await expect(runProfilePluginCommand({ ...failedExit.options, spec: 'bundle@1.0.0',
    signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_install_failed')
  expect(readdirSync(failedExit.control)).toEqual([])

  const failedLaunch = fixture()
  const blockedNode = join(failedLaunch.root, 'blocked-node')
  writeFileSync(blockedNode, '', { mode: 0o600 })
  await expect(runProfilePluginCommand({ ...failedLaunch.options, nodeExecutablePath: blockedNode, spec: 'bundle@1.0.0',
    signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_launch_failed')
  expect(readdirSync(failedLaunch.control)).toEqual([])

  const revoked = fixture(); let guards = 0
  await expect(runProfilePluginCommand({ ...revoked.options, spec: 'bundle@1.0.0',
    signal: new AbortController().signal, guard() { if (++guards === 3) throw Error('revoked after install') } }))
    .rejects.toThrow('plugin_authority_revoked')
  expect(guards).toBe(3)
  expect(readdirSync(revoked.control)).toEqual([])
})
it('cancels a running installer and waits for process exit', async () => {
  const f = fixture()
  writeFileSync(f.pnpm, 'setInterval(()=>{},1000)')
  const controller = new AbortController()
  const pending = runProfilePluginCommand({ ...f.options, spec: `github:owner/repo#${'a'.repeat(40)}`, signal: controller.signal, guard() {} })
  const timer = setTimeout(() => { controller.abort() }, 150)
  try { await expect(pending).rejects.toThrow('plugin_install_cancelled') } finally { clearTimeout(timer) }
})

it('enforces the install deadline and force-kills a process that ignores graceful termination', async () => {
  const f = fixture()
  writeFileSync(f.cli, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")
  const schedule = globalThis.setTimeout
  const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => schedule(
    callback, delay === 120_000 ? 1_000 : delay === 2_000 ? 100 : delay,
  ))
  onTestFinished(() => { timers.mockRestore() })
  await expect(runProfilePluginCommand({ ...f.options, spec: 'bundle@1.0.0',
    signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_install_timeout')
  expect(readdirSync(f.control)).toEqual([])
})

it('reports a process-group termination failure and still performs the forced cleanup', async () => {
  const f = fixture(); let authorized = true
  writeFileSync(f.cli, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")
  const nativeKill = process.kill.bind(process)
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  const kill = vi.spyOn(process, 'kill')
    .mockImplementationOnce(() => { throw denied })
    .mockImplementation((pid, signal) => nativeKill(pid, signal))
  onTestFinished(() => { kill.mockRestore() })
  const controller = new AbortController()
  const pending = runProfilePluginCommand({ ...f.options, spec: 'bundle@1.0.0', signal: controller.signal,
    guard() { if (!authorized) throw Error('revoked') } })
  const timer = setTimeout(() => { authorized = false; controller.abort() }, 150)
  try { await expect(pending).rejects.toThrow('plugin_termination_failed') } finally { clearTimeout(timer) }
  expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL')
  expect(readdirSync(f.control)).toEqual([])
})

it('stops an in-flight installer when the Profile lease is revoked', async () => {
  const f = fixture(); let authorized = true
  writeFileSync(f.pnpm, "require('node:fs').writeFileSync(process.env.DSH_HOME+'/ready','yes');setInterval(()=>{},1000)")
  const controller = new AbortController()
  const pending = runProfilePluginCommand({ ...f.options, spec: 'bundle@1.0.0', signal: controller.signal,
    guard() { if (!authorized) throw Error('revoked') } })
  const observed = expect(pending).rejects.toThrow('plugin_authority_revoked')
  try {
    for (let attempt = 0; attempt < 400 && !existsSync(join(f.profile, 'ready')); attempt++) await pause(5)
    expect(existsSync(join(f.profile, 'ready'))).toBe(true)
    authorized = false
    await observed
    expect(readdirSync(f.control)).toEqual([])
  } finally { controller.abort(); await pending.catch(() => {}) }
})
it('removes only an exact package name without running lifecycle scripts', async () => {
  const f = fixture()
  await runProfilePluginCommand({ ...f.options, action:'remove', spec:'@fixture/bundle', signal:new AbortController().signal, guard(){} })
  expect((JSON.parse(readFileSync(join(f.profile,'observed.json'),'utf8')) as { args: string[] }).args).toEqual(['remove','@fixture/bundle','--config.ignore-scripts=true'])
  await expect(runProfilePluginCommand({ ...f.options,action:'remove',spec:'../escape',signal:new AbortController().signal,guard(){} })).rejects.toThrow()
})


it('repairs the current Profile dependency graph with fixed arguments and lifecycle scripts disabled', async () => {
  const f = fixture()
  await runProfilePluginCommand({ ...f.options, action: 'repair', spec: '@fixture/bundle', signal: new AbortController().signal, guard() {} })
  expect(JSON.parse(readFileSync(join(f.profile, 'observed.json'), 'utf8'))).toEqual({
    args: ['install', '--no-frozen-lockfile', '--ignore-scripts'], home: f.profile,
  })
  expect(readdirSync(f.control)).toEqual([])
})
