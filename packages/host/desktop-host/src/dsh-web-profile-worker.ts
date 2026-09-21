import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import { HostAuthorityError } from './types.ts'

const execFileAsync = promisify(execFile)
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})(?:\/[^\s?]*)?(?:\?[^\s]*)?)(?: \(LAN: .+\))?$/u
const RESERVED_ENV = new Set([
  'DSH_HOME', 'DSH_PROFILE_ID', 'DSH_PROFILE_CREDENTIAL_HANDLE', 'DSH_PROFILE_PLUGIN_ROOTS',
  'DSH_PROFILE_REMOTE_SESSION_TOKEN',
  'DSH_PROFILE_DEFAULT_PLUGINS',
])
// The Profile's environment is whatever the Host hands over on fd 3, never the ambient one.
// SystemRoot and its siblings are the exception: libuv injects them into every child it spawns
// and takes their values from the spawning process, so a Profile that drops them leaves every
// node child it later starts unable to seed its CSPRNG, which aborts before any script runs.
// They name the OS install, not the host context, so preserving them leaks nothing; the Host's
// own values still win because input.environment is assigned last.
const WINDOWS_BOOTSTRAP_INPUT_LIMIT = 64 * 1024
/**
 * The Profile bootstrap's environment handoff, exported so tests execute this exact source
 * instead of a copy that could drift from what the child actually runs.
 */
export const PROFILE_ENVIRONMENT_HANDOFF = `const platformRequired = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(?:SystemRoot|windir|SystemDrive)$/iu.test(key)));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, platformRequired, input.environment);`

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
${PROFILE_ENVIRONMENT_HANDOFF}
const entry = process.argv[1];
if (typeof entry !== 'string' || entry.length === 0) throw Error('profile_entry_invalid');
const dsh = await import(pathToFileURL(entry, { windows: true }).href);
if (typeof dsh.runCli !== 'function') throw Error('profile_entry_invalid');
await dsh.runCli();
`

/** Exact packaged plugin offered to a Profile only through the baseline reconciler. */
export interface DefaultProfilePlugin {
  readonly name: string
  readonly version: string
}

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
  /**
   * Receives one bounded, redacted line whenever a worker fails to reach readiness.
   * The Host authority vocabulary collapses every such failure onto `unavailable`,
   * which cannot be diagnosed from the launcher; this is the only channel that says why.
   */
  readonly onDiagnostic?: (detail: string) => void
  readonly defaultProfilePlugins?: readonly DefaultProfilePlugin[]
}

/** Longest worker diagnostic the launcher accepts, so one failure cannot flood its log. */
const MAX_DIAGNOSTIC_BYTES = 2048

/**
 * Reduce untrusted worker output to one bounded, single-line diagnostic.
 * The readiness bearer token this package itself prints is removed; the rest is worker
 * output the launcher must still treat as untrusted, not as redacted text.
 * @param detail - failure summary plus the worker's own stderr tail.
 * @returns one line, at most {@link MAX_DIAGNOSTIC_BYTES} characters, without the view token.
 */
export function redactWorkerDiagnostic(detail: string): string {
  return detail
    // The readiness line and its retries carry a bearer token for the Profile view.
    .replace(/(\?|&)token=[^\s&]*/gu, '$1token=<redacted>')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_BYTES)
}

/** @internal Verify the Web worker's macOS loopback listener ownership. */
export async function attestMacOSListener(pid: number, origin: string): Promise<void> {
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
  const cookie = cookies[0] as string
  const match = new RegExp(
    '^(dsh-auth-[A-Za-z0-9_-]+)=(v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)'
    + '; Max-Age=\\d+; Path=/; Expires=[^;]+; HttpOnly; SameSite=Strict$',
    'u',
  ).exec(cookie)
  if (match === null) throw new HostAuthorityError('unavailable')
  const name = match[1] as string
  const value = match[2] as string
  const unauthorized = await fetch(`${origin}/`, { redirect: 'manual', signal })
  await unauthorized.body?.cancel()
  if (unauthorized.status !== 401) throw new HostAuthorityError('unavailable')
  const authorized = await fetch(`${origin}/`, {
    headers: { cookie: `${name}=${value}` }, redirect: 'manual', signal,
  })
  await authorized.body?.cancel()
  if (authorized.status !== 200) throw new HostAuthorityError('unavailable')
  return { name, value }
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
    const remoteSessionToken = randomBytes(32).toString('base64url')
    const environment = {
      ...spec.env,
      DSH_HOME: root,
      DSH_PROFILE_ID: spec.profileId,
      DSH_PROFILE_CREDENTIAL_HANDLE: spec.credentialHandle,
      DSH_PROFILE_PLUGIN_ROOTS: JSON.stringify(spec.pluginRoots),
      DSH_PROFILE_REMOTE_SESSION_TOKEN: remoteSessionToken,
      DSH_PROFILE_DEFAULT_PLUGINS: JSON.stringify(this.options.defaultProfilePlugins ?? []),
    }
    const windows = process.platform === 'win32' || this.options.platform === 'win32'
    const configurationInput = windows
      ? `${JSON.stringify({ version: 1, environment })}\n`
      : undefined
    if (configurationInput !== undefined
      && Buffer.byteLength(configurationInput, 'utf8') > WINDOWS_BOOTSTRAP_INPUT_LIMIT) {
      throw new HostAuthorityError('invalid_input')
    }
    const spawnedAt = performance.now()
    const child = (this.options.spawnProcess ?? spawn)(this.options.nodeExecutablePath, [
      ...(windows
        ? ['--expose-internals', '--input-type=module', '--eval', windowsProfileBootstrap, this.options.dshEntrypointPath]
        : [this.options.dshEntrypointPath]),
      '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
    ], {
      cwd: root,
      env: windows ? {} : environment,
      stdio: windows ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    if (configurationInput !== undefined) this.sendWindowsConfiguration(child, configurationInput)
    const activated = await this.waitForOrigin(child, spawnedAt)
    this.generation += 1
    return this.handle(child, activated.origin, activated.bootstrapCookie, this.generation, remoteSessionToken)
  }

  private sendWindowsConfiguration(child: ChildProcess, input: string): void {
    const configurationInput = child.stdio[3] as Writable | null | undefined
    if (!configurationInput) {
      this.options.onDiagnostic?.('profile worker started without its private configuration channel')
      child.kill('SIGKILL')
      throw new HostAuthorityError('unavailable')
    }
    configurationInput.once('error', () => { child.kill('SIGKILL') })
    configurationInput.end(input)
  }

  private async waitForOrigin(child: ChildProcess, spawnedAt: number): Promise<{
    readonly origin: string
    readonly bootstrapCookie: { readonly name: string; readonly value: string }
  }> {
    const pid = child.pid
    if (!pid || !child.stdout) { child.kill('SIGKILL'); throw new HostAuthorityError('unavailable') }
    child.stdout.setEncoding('utf8')
    // An unread pipe fills and then blocks the worker mid-boot, so its stderr is always
    // drained; only a bounded tail is kept, and only for a readiness failure.
    let errorTail = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      errorTail = (errorTail + chunk).slice(-MAX_DIAGNOSTIC_BYTES * 2)
    })
    let buffer = ''
    let timedOut = false
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
      buffer = lines.pop() as string
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
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 30_000
    const timer = setTimeout(() => {
      timedOut = true; deadline.abort(); rejectReady(new HostAuthorityError('unavailable'))
    }, readyTimeoutMs)
    try {
      const { authenticatedUrl, origin } = await ready
      await (this.options.attestListener ?? attestMacOSListener)(pid, origin)
      const bootstrapCookie = await exchangeBootstrap(authenticatedUrl, origin, deadline.signal)
      return { origin, bootstrapCookie }
    } catch (error) {
      child.kill('SIGKILL')
      this.options.onDiagnostic?.(redactWorkerDiagnostic(
        `profile worker failed ${String(Math.round(performance.now() - spawnedAt))}ms after spawn`
        + `${timedOut ? ` (readiness timeout ${String(readyTimeoutMs)}ms)` : ''}`
        + `: ${error instanceof Error ? error.message : 'unknown error'}`
        + `${errorTail === '' ? '' : `; worker stderr: ${errorTail}`}`,
      ))
      // An exit before readiness already aborts the deadline, so the timeout flag, not the
      // signal, decides whether the child's own failure survives into the thrown error.
      if (timedOut) throw new HostAuthorityError('unavailable')
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
    remoteSessionToken: string,
  ): ProfileWorkerHandle {
    // Readiness removed the only reader of these pipes; a full pipe would block the
    // running worker, so both are drained for the rest of its life.
    child.stdout?.resume()
    child.stderr?.resume()
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
      remoteSession: (command, signal) => this.remoteSession(
        viewOrigin, remoteSessionToken, command, signal, () => requestedStop || settled,
      ),
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

  private async remoteSession(
    viewOrigin: string,
    token: string,
    command: HostRemoteSessionCommand,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<HostRemoteSessionJson> {
    if (stopped()) throw new HostAuthorityError('unavailable')
    const response = await fetch(`${viewOrigin}/internal/desktop-remote-session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    })
    if (!response.ok) { await response.body?.cancel(); throw new HostAuthorityError('unavailable') }
    const body = await response.text()
    if (Buffer.byteLength(body) > 512 * 1024) throw new HostAuthorityError('unavailable')
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new HostAuthorityError('unavailable') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'value')) {
      throw new HostAuthorityError('unavailable')
    }
    return (parsed as { value: HostRemoteSessionJson }).value
  }
}
