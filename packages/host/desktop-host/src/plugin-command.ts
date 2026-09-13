import { spawn } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { buildPluginCommand } from '#hub-plugin-command'

/** Host-owned binaries and selected Profile; renderer input supplies only the immutable package spec. */
export interface ProfilePluginCommand {
  nodeExecutablePath: string
  dshEntrypointPath: string
  pnpmEntrypointPath: string
  profileRoot: string
  controlRoot: string
  uid: number
  spec: string
  action?: 'remove' | 'repair'
  signal: AbortSignal
  guard(this: void): void
}

const exactNpm = new RegExp('^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@'
  + '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$', 'u')
const exactGit = /^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)#[a-f0-9]{40}$/iu
/** @param spec Package source. @returns Whether the source pins an npm version or full Git commit. */
export function isPinnedPluginSpec(spec: string): boolean {
  const git = exactGit.exec(spec)
  return spec.length <= 256 && (exactNpm.test(spec) || !!git && [git[1], git[2]].every(part => part !== '.' && part !== '..'))
}
function shellQuote(path: string): string { return `'${path.replaceAll("'", "'\\''")}'` }

/**
 * Run add/remove or dependency repair with explicit binaries, disabled lifecycle scripts, and a private pnpm shim.
 * @param input Host authority, immutable source or exact removal name, and cancellation lifetime.
 * @returns Completion after CLI exit; it does not acknowledge plugin activation or repair partial installs.
 */
export async function runProfilePluginCommand(input: ProfilePluginCommand): Promise<void> {
  input.guard(); input.signal.throwIfAborted()
  if (process.platform === 'win32' || (input.action === 'remove' || input.action === 'repair'
    ? input.spec.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(input.spec) : !isPinnedPluginSpec(input.spec))) throw Error('invalid_plugin_command')
  for (const path of [input.profileRoot, input.controlRoot]) {
    if (!isAbsolute(path)) throw Error('unsafe_plugin_directory')
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.uid !== input.uid || (stat.mode & 0o022) !== 0) throw Error('unsafe_plugin_directory')
  }
  for (const path of [input.nodeExecutablePath, input.dshEntrypointPath, input.pnpmEntrypointPath]) {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path) || !lstatSync(path).isFile()) throw Error('invalid_plugin_binary')
  }
  const shim = mkdtempSync(join(input.controlRoot, 'plugin-command-'))
  try {
    writeFileSync(join(shim, 'pnpm'), `#!/bin/sh\nexec ${shellQuote(input.nodeExecutablePath)} ${shellQuote(input.pnpmEntrypointPath)} "$@"\n`, { mode: 0o700 })
    input.guard(); input.signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(input.nodeExecutablePath, [input.dshEntrypointPath,
        ...(input.action === 'repair' ? ['plugin', '--profile', 'web', 'install', '--no-frozen-lockfile', '--ignore-scripts']
          : buildPluginCommand('web', input.action ?? 'add', input.action === 'remove'
            ? [input.spec, '--config.ignore-scripts=true'] : [input.spec, '--save-exact', '--ignore-scripts']))], {
        cwd: input.profileRoot, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${shim}:${dirname(input.nodeExecutablePath)}:/usr/bin:/bin`, HOME: homedir(), DSH_HOME: input.profileRoot, CI: '1' },
      })
      let failure: string | undefined; let killTimer: ReturnType<typeof setTimeout> | undefined
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return
        try { process.kill(-child.pid, signal) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = 'plugin_termination_failed'
        }
      }
      const stop = (reason: string) => {
        if (failure) return
        failure = reason; kill('SIGTERM'); killTimer = setTimeout(() => { kill('SIGKILL') }, 2_000)
      }
      const abort = () => { stop('plugin_install_cancelled') }
      input.signal.addEventListener('abort', abort, { once: true })
      const deadline = setTimeout(() => { stop('plugin_install_timeout') }, 120_000)
      const authority = setInterval(() => { try { input.guard() } catch { stop('plugin_authority_revoked') } }, 100)
      // Drain both pipes without retaining package output or credentials in Host receipts.
      child.stdout.resume(); child.stderr.resume()
      child.once('error', () => { failure = 'plugin_launch_failed' })
      child.once('close', (code) => {
        clearTimeout(deadline); clearInterval(authority); if (killTimer) clearTimeout(killTimer)
        input.signal.removeEventListener('abort', abort)
        if (failure) { kill('SIGKILL'); reject(Error(failure)) }
        else if (code !== 0) reject(Error('plugin_install_failed'))
        else resolve()
      })
      if (input.signal.aborted) abort()
    })
    input.guard(); input.signal.throwIfAborted()
  } finally { rmSync(shim, { recursive: true, force: true }) }
}
