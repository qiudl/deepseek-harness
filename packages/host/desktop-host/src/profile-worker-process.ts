import { spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import { HostAuthorityError } from './types.ts'

const RESERVED_ENV = new Set(['DSH_PROFILE_ID', 'DSH_PROFILE_ROOT', 'DSH_PROFILE_CREDENTIAL_HANDLE', 'DSH_PROFILE_PLUGIN_ROOTS'])

/** Explicit launch configuration for Profile child processes. */
export interface ProfileWorkerProcessFactoryOptions {
  readonly executablePath: string
  readonly arguments: (spec: ProfileWorkerSpec) => readonly string[]
  readonly readyTimeoutMs?: number
  readonly abortTimeoutMs?: number
}

function validateSpec(spec: ProfileWorkerSpec): void {
  if (spec.profileId.length < 1 || spec.profileId.length > 128 || !isAbsolute(spec.profileRoot)
    || spec.credentialHandle.length < 1 || spec.credentialHandle.length > 512
    || spec.pluginRoots.some(root => !isAbsolute(root))) throw new HostAuthorityError('invalid_input')
}

function childEnvironment(spec: ProfileWorkerSpec): NodeJS.ProcessEnv {
  if (Object.keys(spec.env).some(key => RESERVED_ENV.has(key))) throw new HostAuthorityError('invalid_input')
  const profileRoot = realpathSync(spec.profileRoot)
  return {
    ...spec.env,
    DSH_PROFILE_ID: spec.profileId,
    DSH_PROFILE_ROOT: profileRoot,
    DSH_PROFILE_CREDENTIAL_HANDLE: spec.credentialHandle,
    DSH_PROFILE_PLUGIN_ROOTS: JSON.stringify(spec.pluginRoots),
  }
}

/** Starts real isolated Profile children without forwarding the ambient environment. */
export class ProfileWorkerProcessFactory {
  constructor(private readonly options: ProfileWorkerProcessFactoryOptions) {
    if (!isAbsolute(options.executablePath)) throw new HostAuthorityError('invalid_input')
  }

  /**
   * Spawn one child and wait for its exact IPC readiness message.
   * @param spec - Profile-owned root, opaque credential handle, plugins, and explicit environment.
   * @returns child lifecycle handle whose abort reaches process exit.
   */
  async create(spec: ProfileWorkerSpec): Promise<ProfileWorkerHandle> {
    validateSpec(spec)
    const child = spawn(this.options.executablePath, [...this.options.arguments(spec)], {
      cwd: realpathSync(spec.profileRoot),
      env: childEnvironment(spec),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    return await this.readyHandle(child)
  }

  private async readyHandle(child: ChildProcess): Promise<ProfileWorkerHandle> {
    const stderr = child.stderr
    if (!stderr) { child.kill('SIGKILL'); throw new HostAuthorityError('unavailable') }
    let requestedStop = false
    let settled = false
    let resolveDone!: () => void
    let rejectDone!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    const settleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (requestedStop || code === 0) resolveDone()
      else rejectDone(new Error(`Profile worker exited unexpectedly with code ${String(code)} and signal ${String(signal)}`))
    }
    child.once('error', (error) => { if (!settled) { settled = true; rejectDone(error) } })
    child.once('exit', settleExit)
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const onMessage = (message: unknown): void => {
      if (typeof message === 'object' && message !== null && !Array.isArray(message)
        && Object.keys(message).length === 1 && (message as { type?: unknown }).type === 'ready') readyResolve()
    }
    child.on('message', onMessage)
    void done.catch((error: unknown) => {
      readyReject(error instanceof Error ? error : new HostAuthorityError('unavailable'))
    })
    const timeout = setTimeout(() => { readyReject(new HostAuthorityError('unavailable')) }, this.options.readyTimeoutMs ?? 15_000)
    try { await ready } catch (error) {
      requestedStop = true
      child.kill('SIGKILL')
      await done.catch(() => {})
      throw error
    } finally { clearTimeout(timeout) }
    return {
      closeNotifications() { child.off('message', onMessage); stderr.removeAllListeners() },
      abort: () => {
        if (settled || requestedStop) return
        requestedStop = true
        child.send({ type: 'shutdown' }, (error) => {
          if (error && !settled) child.kill('SIGTERM')
        })
        const killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL') }, this.options.abortTimeoutMs ?? 5_000)
        void done.finally(() => { clearTimeout(killTimer) })
      },
      done,
    }
  }
}
