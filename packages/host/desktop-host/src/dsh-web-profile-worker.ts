import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import { HostAuthorityError } from './types.ts'

const execFileAsync = promisify(execFile)
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})(?:\/[^\s?]*)?(?:\?[^\s]*)?)(?: \(LAN: .+\))?$/u
const RESERVED_ENV = new Set([
  'DSH_HOME', 'DSH_PROFILE_ID', 'DSH_PROFILE_CREDENTIAL_HANDLE', 'DSH_PROFILE_PLUGIN_ROOTS',
])
const WINDOWS_BOOTSTRAP_INPUT_LIMIT = 64 * 1024
const windowsProfileBootstrap = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const bytes = readFileSync(3);
if (bytes.length < 2 || bytes.length > 65536) throw Error('profile_config_size');
const input = JSON.parse(bytes.toString('utf8'));
if (!input || typeof input !== 'object' || Array.isArray(input)
  || Object.keys(input).sort().join(',') !== 'environment,version' || input.version !== 1
  || !input.environment || typeof input.environment !== 'object' || Array.isArray(input.environment)
  || Object.entries(input.environment).some(([key, value]) => !key || key.includes('=')
    || /[\\u0000]/u.test(key) || typeof value !== 'string' || /[\\u0000]/u.test(value))) {
  throw Error('profile_config_invalid');
}
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, input.environment);
const entry = process.argv[1];
if (typeof entry !== 'string' || entry.length === 0) throw Error('profile_entry_invalid');
await import(pathToFileURL(entry, { windows: true }).href);
`

/** Verifies that a child PID, rather than another local process, owns a loopback listener. */
export type ProfileListenerAttestor = (pid: number, origin: string) => Promise<void>

/** Launch configuration for `dsh --profile web` Profile workers. */
export interface DshWebProfileWorkerFactoryOptions {
  readonly nodeExecutablePath: string
  readonly dshEntrypointPath: string
  readonly attestListener?: ProfileListenerAttestor
  readonly readyTimeoutMs?: number
  readonly abortTimeoutMs?: number
  readonly platform?: NodeJS.Platform
  readonly spawnProcess?: typeof spawn
}

async function attestMacOSListener(pid: number, origin: string): Promise<void> {
  if (process.platform !== 'darwin') throw new HostAuthorityError('unavailable')
  const port = new URL(origin).port
  const { stdout } = await execFileAsync('/usr/sbin/lsof', [
    '-nP', '-a', '-p', String(pid), `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fn',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 })
  if (!stdout.split(/\r?\n/u).includes(`p${String(pid)}`)) throw new HostAuthorityError('unavailable')
}

function readyView(line: string): { readonly origin: string; readonly authenticatedUrl: string } | undefined {
  const match = READY_LINE.exec(line)
  if (!match?.[1]) return undefined
  const parsed = new URL(match[1])
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) return undefined
  return { origin: parsed.origin, authenticatedUrl: parsed.toString() }
}

async function exchangeBootstrap(
  authenticatedUrl: string,
  origin: string,
  signal: AbortSignal,
): Promise<{ readonly name: string; readonly value: string }> {
  const response = await fetch(authenticatedUrl, { redirect: 'manual', signal })
  await response.body?.cancel()
  if (response.status !== 303 || response.headers.get('location') !== '/') throw new HostAuthorityError('unavailable')
  const cookies = response.headers.getSetCookie()
  if (cookies.length !== 1) throw new HostAuthorityError('unavailable')
  const match = /^(dsh-auth-[A-Za-z0-9_-]+)=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+); Max-Age=\d+; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Strict$/u.exec(cookies[0] ?? '')
  if (!match?.[1] || !match[2]) throw new HostAuthorityError('unavailable')
  const unauthorized = await fetch(`${origin}/`, { redirect: 'manual', signal })
  await unauthorized.body?.cancel()
  if (unauthorized.status !== 401) throw new HostAuthorityError('unavailable')
  const authorized = await fetch(`${origin}/`, {
    headers: { cookie: `${match[1]}=${match[2]}` }, redirect: 'manual', signal,
  })
  await authorized.body?.cancel()
  if (authorized.status !== 200) throw new HostAuthorityError('unavailable')
  return { name: match[1], value: match[2] }
}

/** Real child-process factory for one existing `dsh web` composition per Person Profile. */
export class DshWebProfileWorkerFactory {
  private generation = 0
  constructor(private readonly options: DshWebProfileWorkerFactoryOptions) {
    if (!isAbsolute(options.nodeExecutablePath) || !isAbsolute(options.dshEntrypointPath)) throw new HostAuthorityError('invalid_input')
  }

  /**
   * Launch an existing Web profile with a Profile-scoped DSH home and attest its listener.
   * @param spec - selected Person Profile root and opaque local handles.
   * @returns lifecycle plus a Host-verified token-free loopback origin.
   */
  async create(spec: ProfileWorkerSpec): Promise<ProfileWorkerHandle> {
    if (Object.keys(spec.env).some(key => RESERVED_ENV.has(key))) throw new HostAuthorityError('invalid_input')
    const root = realpathSync(spec.profileRoot)
    const environment = {
      ...spec.env,
      DSH_HOME: root,
      DSH_PROFILE_ID: spec.profileId,
      DSH_PROFILE_CREDENTIAL_HANDLE: spec.credentialHandle,
      DSH_PROFILE_PLUGIN_ROOTS: JSON.stringify(spec.pluginRoots),
    }
    const windows = process.platform === 'win32' || this.options.platform === 'win32'
    const configurationInput = windows
      ? `${JSON.stringify({ version: 1, environment })}\n`
      : undefined
    if (configurationInput !== undefined
      && Buffer.byteLength(configurationInput, 'utf8') > WINDOWS_BOOTSTRAP_INPUT_LIMIT) {
      throw new HostAuthorityError('invalid_input')
    }
    const child = (this.options.spawnProcess ?? spawn)(this.options.nodeExecutablePath, [
      ...(windows
        ? ['--input-type=module', '--eval', windowsProfileBootstrap, this.options.dshEntrypointPath]
        : [this.options.dshEntrypointPath]),
      '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
    ], {
      cwd: root,
      env: windows ? {} : environment,
      stdio: windows ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    if (configurationInput !== undefined) this.sendWindowsConfiguration(child, configurationInput)
    const activated = await this.waitForOrigin(child)
    this.generation += 1
    return this.handle(child, activated.origin, activated.bootstrapCookie, this.generation)
  }

  private sendWindowsConfiguration(child: ChildProcess, input: string): void {
    const configurationInput = child.stdio[3] as Writable | null | undefined
    if (!configurationInput) {
      child.kill('SIGKILL')
      throw new HostAuthorityError('unavailable')
    }
    configurationInput.once('error', () => { child.kill('SIGKILL') })
    configurationInput.end(input)
  }

  private async waitForOrigin(child: ChildProcess): Promise<{
    readonly origin: string
    readonly bootstrapCookie: { readonly name: string; readonly value: string }
  }> {
    const pid = child.pid
    if (!pid || !child.stdout) { child.kill('SIGKILL'); throw new HostAuthorityError('unavailable') }
    child.stdout.setEncoding('utf8')
    let buffer = ''
    const deadline = new AbortController()
    let resolveReady!: (view: { readonly origin: string; readonly authenticatedUrl: string }) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<{ readonly origin: string; readonly authenticatedUrl: string }>((resolve, reject) => {
      resolveReady = resolve; rejectReady = reject
    })
    const onData = (chunk: string): void => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 64 * 1024) { rejectReady(new HostAuthorityError('unavailable')); return }
      const lines = buffer.split(/\r?\n/u)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const view = readyView(line)
        if (view !== undefined) { resolveReady(view); return }
      }
    }
    child.stdout.on('data', onData)
    child.once('error', rejectReady)
    child.once('exit', (code, exitSignal) => {
      deadline.abort()
      rejectReady(new Error(`Profile Web worker exited before readiness with code ${String(code)} and signal ${String(exitSignal)}`))
    })
    const timer = setTimeout(() => {
      deadline.abort(); rejectReady(new HostAuthorityError('unavailable'))
    }, this.options.readyTimeoutMs ?? 30_000)
    try {
      const { authenticatedUrl, origin } = await ready
      await (this.options.attestListener ?? attestMacOSListener)(pid, origin)
      const bootstrapCookie = await exchangeBootstrap(authenticatedUrl, origin, deadline.signal)
      return { origin, bootstrapCookie }
    } catch (error) {
      child.kill('SIGKILL')
      if (deadline.signal.aborted) throw new HostAuthorityError('unavailable')
      throw error
    } finally {
      clearTimeout(timer)
      child.stdout.off('data', onData)
    }
  }

  private handle(
    child: ChildProcess,
    viewOrigin: string,
    bootstrapCookie: { readonly name: string; readonly value: string },
    generation: number,
  ): ProfileWorkerHandle {
    let requestedStop = false
    let settled = false
    let resolveDone!: () => void
    let rejectDone!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    child.once('error', (error) => { if (!settled) { settled = true; rejectDone(error) } })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (requestedStop || code === 0) resolveDone()
      else rejectDone(new Error(`Profile Web worker exited unexpectedly with code ${String(code)} and signal ${String(signal)}`))
    })
    return {
      viewOrigin,
      generation,
      bootstrapCookie,
      closeNotifications() { child.stdout?.removeAllListeners(); child.stderr?.removeAllListeners() },
      abort: () => {
        if (requestedStop || settled) return
        requestedStop = true
        child.kill('SIGTERM')
        const timer = setTimeout(() => { if (!settled) child.kill('SIGKILL') }, this.options.abortTimeoutMs ?? 5_000)
        void done.finally(() => { clearTimeout(timer) })
      },
      done,
    }
  }
}
