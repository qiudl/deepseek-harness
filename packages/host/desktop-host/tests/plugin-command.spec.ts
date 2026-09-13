import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as pause } from 'node:timers/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { runProfilePluginCommand } from '../src/plugin-command.ts'

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
it('rejects mutable specs and revocation before launching', async () => {
  const f = fixture()
  for (const spec of ['bundle@latest', '../local', '--ignore-scripts', 'github:owner/repo#main']) {
    await expect(runProfilePluginCommand({ ...f.options, spec, signal: new AbortController().signal, guard() {} })).rejects.toThrow()
  }
  await expect(runProfilePluginCommand({ ...f.options, spec: 'bundle@1.0.0', signal: new AbortController().signal, guard() { throw Error('revoked') } })).rejects.toThrow()
})
it('cancels a running installer and waits for process exit', async () => {
  const f = fixture()
  writeFileSync(f.pnpm, 'setInterval(()=>{},1000)')
  const controller = new AbortController()
  const pending = runProfilePluginCommand({ ...f.options, spec: `github:owner/repo#${'a'.repeat(40)}`, signal: controller.signal, guard() {} })
  const timer = setTimeout(() => { controller.abort() }, 150)
  try { await expect(pending).rejects.toThrow('plugin_install_cancelled') } finally { clearTimeout(timer) }
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
