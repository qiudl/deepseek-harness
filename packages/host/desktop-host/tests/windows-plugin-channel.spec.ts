import { assertWindowsExtensionDirectory, readWindowsExtensionStateFile, readWindowsExtensionBackupFile, writeWindowsExtensionStateFile } from '../src/windows-extension-files.ts'
import { assertWindowsWorkerMutableFileEvidence } from '../src/windows-isolated-profile.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { runProfilePluginCommand } from '../src/plugin-command.ts'
import { ProfilePluginExecutor } from '../src/profile-plugin-executor.ts'
import type { PluginToggleRecovery, ExtensionReceipt } from '../src/extension-operations.ts'
import type { PluginTogglePlan } from '../src/plugin-toggle-plan.ts'
import type {
  WindowsHostPrivatePathEvidence,
  WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'

const sid = 'S-1-5-21-1000-2000-3000-1001'
const FULL_CONTROL = 0x1F01FF

function evidence(kind: 'file' | 'directory'): WindowsHostPrivatePathEvidence {
  return { kind, reparsePoint: false, linkCount: 1, ownerSid: sid, daclProtected: true,
    access: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(principal => ({ sid: principal, type: 'allow',
      mask: FULL_CONTROL, inherited: false, objectInherit: true, containerInherit: true })) }
}

/** Worker/pnpm replacements inherit the private parent DACL instead of restating it. */
function mutableEvidence(): WindowsHostPrivatePathEvidence {
  return { kind: 'file', reparsePoint: false, linkCount: 1, ownerSid: sid, daclProtected: false,
    access: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(principal => ({ sid: principal, type: 'allow',
      mask: FULL_CONTROL, inherited: true, objectInherit: true, containerInherit: true })) }
}

/** Real-directory backed bindings: evidence is fabricated, contents live on disk. */
function diskBindings() {
  const bindings = {
    inspectExistingDirectory: vi.fn(() => evidence('directory')),
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((path, max) => {
      let contents: Buffer
      try { contents = readFileSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      if (contents.length > max) throw Error('oversize')
      return { contents, evidence: mutableEvidence() }
    }),
    replacePrivateFile: vi.fn((path: string, contents: Buffer) => {
      writeFileSync(path, contents)
      return evidence('file')
    }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  } satisfies WindowsHostRegistrationFileBindings
  return bindings
}

function commandFixture() {
  const root = mkdtempSync(join(tmpdir(), 'host-windows-plugin-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const profile = join(root, 'profile'); const control = join(root, 'control')
  mkdirSync(profile); mkdirSync(control)
  const cli = join(root, 'cli.cjs'); const pnpm = join(root, 'pnpm.cjs')
  // The production CLI resolves pnpm.cmd through PATH like execa does; the test CLI uses cmd.exe.
  writeFileSync(cli, "const {spawnSync}=require('node:child_process');"
    + "const r=spawnSync('pnpm.cmd',process.argv.slice(5),{shell:true,stdio:'inherit'});process.exit(r.status??1)")
  writeFileSync(pnpm, "require('node:fs').writeFileSync(process.env.DSH_HOME+'/observed.json',"
    + 'JSON.stringify({args:process.argv.slice(2),home:process.env.DSH_HOME,secret:process.env.PLUGIN_TEST_SECRET??null,'
    + 'path:process.env.PATH,pathext:process.env.PATHEXT??null}));')
  const windows = { userSid: sid, bindings: diskBindings() }
  return { root, profile, control, cli, pnpm, windows, options: { nodeExecutablePath: process.execPath,
    dshEntrypointPath: cli, pnpmEntrypointPath: pnpm, profileRoot: profile, controlRoot: control, uid: 0, windows } }
}

interface ObservedCommand {
  args: string[]
  home: string
  secret: string | null
  path: string
  pathext: string | null
}
function readObserved(profile: string): ObservedCommand {
  return JSON.parse(readFileSync(join(profile, 'observed.json'), 'utf8')) as ObservedCommand
}

const onWindows = it.runIf(process.platform === 'win32')
const offWindows = it.runIf(process.platform !== 'win32')

onWindows('runs the pinned CLI through the pnpm.cmd shim with a scrubbed environment', async () => {
  const f = commandFixture()
  const originalSecret = process.env.PLUGIN_TEST_SECRET
  process.env.PLUGIN_TEST_SECRET = 'must-not-be-forwarded'
  onTestFinished(() => {
    if (originalSecret === undefined) delete process.env.PLUGIN_TEST_SECRET
    else process.env.PLUGIN_TEST_SECRET = originalSecret
  })
  await runProfilePluginCommand({ ...f.options, spec: '@fixture/bundle@1.2.3', signal: new AbortController().signal, guard() {} })
  const observed = readObserved(f.profile)
  expect(observed.args).toEqual(['add', '@fixture/bundle@1.2.3', '--save-exact', '--ignore-scripts'])
  expect(observed.home).toBe(f.profile)
  expect(observed.secret).toBeNull()
  expect(observed.path.split(';')[0]).toContain('plugin-command-')
  expect(observed.path).toContain('System32')
  expect(observed.pathext).toContain('.CMD')
  expect(readdirSync(f.control)).toEqual([])
})

onWindows('removes and repairs with fixed arguments and disabled lifecycle scripts', async () => {
  const removed = commandFixture()
  await runProfilePluginCommand({ ...removed.options, action: 'remove', spec: '@fixture/bundle',
    signal: new AbortController().signal, guard() {} })
  expect(readObserved(removed.profile).args)
    .toEqual(['remove', '@fixture/bundle', '--config.ignore-scripts=true'])

  const repaired = commandFixture()
  await runProfilePluginCommand({ ...repaired.options, action: 'repair', spec: '@fixture/bundle',
    signal: new AbortController().signal, guard() {} })
  expect(readObserved(repaired.profile).args)
    .toEqual(['install', '--no-frozen-lockfile', '--ignore-scripts'])
  expect(readdirSync(repaired.control)).toEqual([])
})

onWindows('persists the exact build approval through the ACL channel before running scripts', async () => {
  const f = commandFixture()
  writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'packages:\n  - profiles/*\nallowBuilds:\n  unrelated: false\n')
  await runProfilePluginCommand({ ...f.options, spec: '@fixture/bundle@1.2.3', allowBuild: '@fixture/bundle@1.2.3',
    signal: new AbortController().signal, guard() {} })
  expect(readObserved(f.profile).args)
    .toEqual(['add', '@fixture/bundle@1.2.3', '--save-exact'])
  const policy = readFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'utf8')
  expect(policy).toContain('"@fixture/bundle@1.2.3": true')
  expect(policy).toContain('unrelated: false')
  expect(f.windows.bindings.replacePrivateFile).toHaveBeenCalledOnce()
})

onWindows('rejects a conflicting build policy and a missing policy file', async () => {
  const conflict = commandFixture()
  writeFileSync(join(conflict.profile, 'pnpm-workspace.yaml'), 'allowBuilds:\n  "@fixture/bundle@1.2.3": false\n')
  await expect(runProfilePluginCommand({ ...conflict.options, spec: '@fixture/bundle@1.2.3',
    allowBuild: '@fixture/bundle@1.2.3', signal: new AbortController().signal, guard() {} }))
    .rejects.toThrow('build_policy_conflict')

  const missing = commandFixture()
  await expect(runProfilePluginCommand({ ...missing.options, spec: '@fixture/bundle@1.2.3',
    allowBuild: '@fixture/bundle@1.2.3', signal: new AbortController().signal, guard() {} }))
    .rejects.toThrow('unsafe_plugin_policy')
})

onWindows('rejects unsafe inputs and missing channels before launching', async () => {
  const f = commandFixture()
  const signal = new AbortController().signal
  const request = { ...f.options, spec: 'bundle@1.0.0', signal, guard() {} }
  const { windows: _windows, ...withoutChannel } = request
  await expect(runProfilePluginCommand(withoutChannel)).rejects.toThrow('invalid_plugin_command')
  await expect(runProfilePluginCommand({ ...request, profileRoot: 'relative' })).rejects.toThrow('unsafe_plugin_directory')
  await expect(runProfilePluginCommand({ ...request, pnpmEntrypointPath: `${f.pnpm}"&whoami"` }))
    .rejects.toThrow('invalid_plugin_binary')
  await expect(runProfilePluginCommand({ ...request, spec: 'bundle@latest' })).rejects.toThrow('invalid_plugin_command')
  f.windows.bindings.inspectExistingDirectory.mockReturnValueOnce({ ...evidence('directory'), reparsePoint: true })
  await expect(runProfilePluginCommand(request)).rejects.toThrow()
})

onWindows('cancels a running installer and terminates the whole process tree', async () => {
  const f = commandFixture()
  writeFileSync(f.pnpm, "require('node:fs').writeFileSync(process.env.DSH_HOME+'/ready',String(process.pid));setInterval(()=>{},1000)")
  const controller = new AbortController()
  const pending = runProfilePluginCommand({ ...f.options, spec: `github:owner/repo#${'a'.repeat(40)}`,
    signal: controller.signal, guard() {} })
  const settled = pending.then(() => ({ kind: 'resolved' as const }), (error: unknown) => ({ kind: 'rejected' as const, error }))
  try {
    await vi.waitFor(() => { expect(existsSync(join(f.profile, 'ready'))).toBe(true) })
    const installerPid = Number(readFileSync(join(f.profile, 'ready'), 'utf8'))
    expect(Number.isSafeInteger(installerPid) && installerPid > 0).toBe(true)
    controller.abort()
    expect(await settled).toMatchObject({ kind: 'rejected', error: { message: 'plugin_install_cancelled' } })
    await vi.waitFor(() => {
      expect(() => process.kill(installerPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    })
    expect(readdirSync(f.control)).toEqual([])
  } finally { controller.abort(); await settled }
})

offWindows('rejects the Windows ACL channel on non-Windows hosts', async () => {
  const f = commandFixture()
  await expect(runProfilePluginCommand({ ...f.options, spec: 'bundle@1.0.0',
    signal: new AbortController().signal, guard() {} })).rejects.toThrow('invalid_plugin_command')
})

/** Map-backed executor fixture: state documents live in memory with fabricated ACL evidence. */
function executorFixture() {
  const root = process.platform === 'win32' ? String.raw`C:\slark-test\profile` : '/slark-test/profile'
  const files = new Map<string, string>()
  const bindings = {
    inspectExistingDirectory: vi.fn(() => evidence('directory')),
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((path, max) => {
      const text = files.get(path)
      if (text === undefined) return undefined
      const contents = Buffer.from(text)
      if (contents.length > max) throw Error('oversize')
      return { contents, evidence: path.includes('.plugin-before-') ? evidence('file') : mutableEvidence() }
    }),
    replacePrivateFile: vi.fn((path: string, contents: Buffer) => {
      files.set(path, contents.toString('utf8'))
      return evidence('file')
    }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  } satisfies WindowsHostRegistrationFileBindings
  const windows = { userSid: sid, bindings }
  const manifest = JSON.stringify({
    dependencies: { '@fixture/bundle': '1.2.3' },
    dsh: { profile: { bundles: ['@fixture/bundle'] } },
  })
  files.set(join(root, 'profiles/web/package.json'), manifest)
  const plan: PluginTogglePlan = { patch: '# disabled\n', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }
  const togglePlan = vi.fn(() => plan)
  const acknowledgeToggle = vi.fn(async () => {})
  const executor = new ProfilePluginExecutor({
    resolve: () => root, uid: 0, windows, togglePlan, acknowledgeToggle,
    install: async () => {},
    acknowledge: async () => {},
  })
  return { root, files, bindings, executor, plan, togglePlan, acknowledgeToggle }
}

it('revises and toggles plugin state entirely through the Windows ACL channel', async () => {
  const f = executorFixture()
  const revision = await f.executor.revision('profile')
  expect(revision).toMatch(/^[0-9a-f]{64}$/u)
  const result = await f.executor.execute('profile',
    JSON.stringify({ action: 'toggle', packageName: '@fixture/bundle', enabled: false }),
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })
  expect(result.state).toBe('succeeded')
  expect(f.files.get(join(f.root, 'profiles/web/cordis.patch.yml'))).toBe('# disabled\n')
  expect(f.acknowledgeToggle).toHaveBeenCalledOnce()
  expect(f.bindings.inspectExistingDirectory).toHaveBeenCalled()
  expect(f.bindings.replacePrivateFile).toHaveBeenCalled()
})

it('rejects foreign-owned or reparse-backed Profile evidence on the Windows channel', async () => {
  const f = executorFixture()
  f.bindings.inspectExistingDirectory.mockReturnValueOnce({ ...evidence('directory'), reparsePoint: true })
  await expect(f.executor.revision('profile')).rejects.toThrow()
  f.bindings.readPrivateFile.mockReturnValueOnce({
    contents: Buffer.from('{}'), evidence: { ...mutableEvidence(), ownerSid: 'S-1-5-21-1000-2000-3000-1002' },
  })
  await expect(f.executor.revision('profile')).rejects.toThrow()
})

it('rejects unavailable native directory inspection and unsafe mutable file access', () => {
  const bindings = diskBindings()
  const channel = { userSid: sid, bindings }
  const { inspectExistingDirectory: _inspect, ...unavailableBindings } = bindings
  expect(() => { assertWindowsExtensionDirectory({ userSid: sid, bindings: unavailableBindings }, '/profile') })
    .toThrow('upgrade_required')
  for (const changed of [
    { access: [{ ...mutableEvidence().access[0]!, type: 'deny' as const }, ...mutableEvidence().access.slice(1)] },
    { access: [{ ...mutableEvidence().access[0]!, mask: 1 }, ...mutableEvidence().access.slice(1)] },
    { access: [mutableEvidence().access[0]!, mutableEvidence().access[0]!, mutableEvidence().access[2]!] },
  ]) expect(() => { assertWindowsWorkerMutableFileEvidence({ ...mutableEvidence(), ...changed }, sid) }).toThrow('unavailable')
  bindings.readPrivateFile.mockReturnValue({ contents: Buffer.alloc(5), evidence: mutableEvidence() })
  expect(() => readWindowsExtensionStateFile(channel, '/state', 4, 'unsafe_state')).toThrow('unsafe_state')
})
it('requires bounded, explicit private backups and publishes protected replacement evidence', () => {
  const bindings = diskBindings()
  const channel = { userSid: sid, bindings }
  expect(() => readWindowsExtensionBackupFile(channel, '/absent')).toThrow('unsafe_backup')
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(1_048_578)]) {
    bindings.readPrivateFile.mockReturnValue({ contents: bytes, evidence: evidence('file') })
    expect(() => readWindowsExtensionBackupFile(channel, '/backup')).toThrow('unsafe_backup')
  }
  bindings.readPrivateFile.mockReturnValue({ contents: Buffer.from('1[]'), evidence: mutableEvidence() })
  expect(() => readWindowsExtensionBackupFile(channel, '/backup')).toThrow('unavailable')
  bindings.readPrivateFile.mockReturnValue({ contents: Buffer.from('1[]'), evidence: evidence('file') })
  expect(readWindowsExtensionBackupFile(channel, '/backup')).toBe('1[]')
  bindings.replacePrivateFile.mockReturnValue(evidence('file'))
  writeWindowsExtensionStateFile(channel, '/state', '[]')
  expect(bindings.replacePrivateFile).toHaveBeenCalledWith('/state', Buffer.from('[]'), expect.stringContaining('D:P'))
})

it('checkpoints a Windows toggle backup and validates interrupted recovery through the native channel', async () => {
  const f = executorFixture()
  const operationId = randomUUID()
  const checkpoints: PluginToggleRecovery[] = []
  await f.executor.execute('profile', JSON.stringify({ action: 'toggle', packageName: '@fixture/bundle', enabled: false }),
    { kind: 'plugin', operationId, signal: new AbortController().signal, guard() {},
      checkpointPluginToggle: row => checkpoints.push(row) })
  const recovery = checkpoints.at(-1)
  if (!recovery) throw Error('missing recovery evidence')
  expect(recovery.stage).toBe('application_verified')
  const receipt: ExtensionReceipt = { version: 1, operationId, profileId: 'profile', planId: randomUUID(),
    kind: 'plugin', digest: 'a'.repeat(64), state: 'unknown', cancellationRequested: false,
    createdAt: 0, updatedAt: 0, pluginToggleRecovery: recovery }
  await expect(f.executor.validatePluginRestore('profile', receipt)).resolves.toBeUndefined()
  const backup = join(f.root, 'profiles/web', `.plugin-before-${operationId}`)
  expect(f.files.get(backup)).toBe('0')
  expect(f.bindings.readPrivateFile).toHaveBeenCalledWith(backup, 1_048_577)
  f.files.set(backup, '1tampered')
  await expect(f.executor.validatePluginRestore('profile', receipt)).rejects.toThrow('invalid_backup')
})
