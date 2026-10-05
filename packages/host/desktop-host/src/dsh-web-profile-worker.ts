import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { HostCollaborationDeliveryCapsule } from '@deepseek-ai/dsh-host-control-protocol'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { parseHostRemoteSessionJson, parseHostWorkspaceModelSelection, parseHostCollaborationSourceDescriptor, parseHostCollaborationSourceSnapshot } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostWorkspaceModelSelectionTarget, HostWorkspaceModelSelection, HostCollaborationSourceTarget, HostCollaborationSourceDescriptor, HostCollaborationSourceSnapshot, HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import { HostAuthorityError } from './types.ts'
import { openRemoteUiWorkerStream } from './remote-ui-stream-client.ts'

const execFileAsync = promisify(execFile)
const REMOTE_UI_ASSET_MAX_BYTES = 8 * 1024 * 1024
const REMOTE_UI_ASSET_CHUNK_BYTES = 24 * 1024
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})(?:\/[^\s?]*)?(?:\?[^\s]*)?)(?: \(LAN: .+\))?$/u
const RESERVED_ENV = new Set([
  'DSH_HOME', 'DSH_PROFILE_ID', 'DSH_PROFILE_CREDENTIAL_HANDLE', 'DSH_PROFILE_PLUGIN_ROOTS',
  'DSH_PROFILE_MODEL_TOKEN', 'DSH_PROFILE_WORKSPACE_MODEL_TOKEN', 'DSH_PROFILE_SOURCE_TOKEN',
  'DSH_PROFILE_ANALYSIS_TOKEN',
  'DSH_PROFILE_DELIVERY_TOKEN',
  'DSH_PROFILE_REMOTE_SESSION_TOKEN',
  'DSH_PROFILE_REMOTE_UI_TOKEN',
  'DSH_SLARK_EMBEDDED',
])

/** Classified failure from the authenticated worker model endpoint. */
export class DesktopModelWorkerError extends Error {
  constructor(readonly code: 'invalid_input' | 'no_default_model' | 'missing_credential'
    | 'provider_failed' | 'cancelled' | 'timeout' | 'response_too_large') {
    super(code)
    this.name = 'DesktopModelWorkerError'
  }
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

/** Project local document-relative plugin references onto the remote Host's root-only asset route. */
function remoteBootReferences(value: unknown): unknown {
  const record = (item: unknown): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
  const root = (url: unknown): unknown =>
    typeof url === 'string' && url.startsWith('plugins/') ? `/${url}` : url
  if (!record(value) || !Array.isArray(value.injections)) return value
  return { ...value, injections: value.injections.map((item: unknown) => {
    if (!record(item)) return item
    if (item.kind === 'script-src' || item.kind === 'script-preload') {
      return { ...item, src: root(item.src) }
    }
    if (item.kind !== 'global' || item.name !== '__DSH_BOOT__' || !record(item.value)) return item
    const graph = item.value
    return { ...item, value: {
      ...graph,
      entries: Array.isArray(graph.entries) ? graph.entries.map((entry: unknown) =>
        record(entry) ? { ...entry, url: root(entry.url) } : entry) : graph.entries,
      batches: Array.isArray(graph.batches) ? graph.batches.map((batch: unknown) =>
        record(batch) ? { ...batch, url: root(batch.url) } : batch) : graph.batches,
    } }
  }) }
}

async function exchangeBootstrap(
  authenticatedUrl: string,
  origin: string,
  signal: AbortSignal,
): Promise<{ readonly name: string; readonly value: string }> {
  const response = await fetch(authenticatedUrl, { redirect: 'manual', signal })
  await response.body?.cancel()
  const location = response.headers.get('location')
  if (response.status !== 303 || (location !== '/' && location !== './')) throw new HostAuthorityError('unavailable')
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
    const sourceToken = randomBytes(32).toString('base64url')
    const analysisToken = randomBytes(32).toString('base64url')
    const deliveryToken = randomBytes(32).toString('base64url')
    const workspaceModelToken = randomBytes(32).toString('base64url')
    const modelToken = randomBytes(32).toString('base64url')
    const remoteSessionToken = randomBytes(32).toString('base64url')
    const remoteUiToken = randomBytes(32).toString('base64url')
    const child = spawn(this.options.nodeExecutablePath, [
      this.options.dshEntrypointPath, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
    ], {
      cwd: root,
      env: {
        ...spec.env,
        DSH_HOME: root,
        DSH_PROFILE_ID: spec.profileId,
        DSH_PROFILE_CREDENTIAL_HANDLE: spec.credentialHandle,
        DSH_PROFILE_PLUGIN_ROOTS: JSON.stringify(spec.pluginRoots),
        DSH_PROFILE_MODEL_TOKEN: modelToken,
        DSH_PROFILE_WORKSPACE_MODEL_TOKEN: workspaceModelToken,
        DSH_PROFILE_SOURCE_TOKEN: sourceToken,
        DSH_PROFILE_ANALYSIS_TOKEN: analysisToken,
        DSH_PROFILE_DELIVERY_TOKEN: deliveryToken,
        DSH_PROFILE_REMOTE_SESSION_TOKEN: remoteSessionToken,
        DSH_PROFILE_REMOTE_UI_TOKEN: remoteUiToken,
        DSH_SLARK_EMBEDDED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const activated = await this.waitForOrigin(child)
    this.generation += 1
    return this.handle(child, activated.origin, activated.bootstrapCookie, this.generation,
      modelToken, remoteSessionToken, remoteUiToken, workspaceModelToken, sourceToken, analysisToken, deliveryToken)
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
    modelToken: string,
    remoteSessionToken: string,
    remoteUiToken: string,
    workspaceModelToken: string,
    sourceToken: string,
    analysisToken: string,
    deliveryToken: string,
  ): ProfileWorkerHandle {
    let requestedStop = false
    let settled = false
    const assetCache: { current?: { readonly url: string; readonly bytes: Buffer } } = {}
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
      generateText: async (text, signal) => {
        if (requestedStop || settled) throw new HostAuthorityError('unavailable')
        const response = await fetch(`${viewOrigin}/internal/desktop-model-text`, {
          method: 'POST',
          headers: { authorization: `Bearer ${modelToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
        })
        const body = await response.text()
        if (Buffer.byteLength(body, 'utf8') > 17_408) throw new HostAuthorityError('unavailable')
        let parsed: unknown
        try { parsed = JSON.parse(body) } catch { throw new HostAuthorityError('unavailable') }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HostAuthorityError('unavailable')
        const value = parsed as Record<string, unknown>
        if (!response.ok) {
          const code = value.error
          if (code === 'invalid_input' || code === 'no_default_model' || code === 'missing_credential'
            || code === 'provider_failed' || code === 'cancelled' || code === 'timeout'
            || code === 'response_too_large') {
            throw new DesktopModelWorkerError(code)
          }
          throw new HostAuthorityError('unavailable')
        }
        if (typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > 256
          || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256
          || typeof value.text !== 'string' || !value.text.trim()
          || Buffer.byteLength(value.text, 'utf8') > 16_384 || Object.keys(value).length !== 3) {
          throw new HostAuthorityError('unavailable')
        }
        return { provider: value.provider, model: value.model, text: value.text }
      },
      readCollaborationSourceSnapshot: (target, signal) => this.readCollaborationSourceSnapshot(
        viewOrigin, sourceToken, target, signal, () => requestedStop || settled,
      ),
      collaborationAnalysis: (command, signal) => this.collaborationAnalysis(
        viewOrigin, analysisToken, command, signal, () => requestedStop || settled,
      ),
      receiveCollaborationDelivery: (command, signal) => this.receiveCollaborationDelivery(
        viewOrigin, deliveryToken, command, signal, () => requestedStop || settled,
      ),
      inspectCollaborationSource: (target, signal) => this.inspectCollaborationSource(
        viewOrigin, sourceToken, target, signal, () => requestedStop || settled,
      ),
      inspectWorkspaceModelSelection: (target, signal) => this.inspectWorkspaceModelSelection(
        viewOrigin, workspaceModelToken, target, signal, () => requestedStop || settled,
      ),
      remoteSession: (command, signal) => this.remoteSession(
        viewOrigin, remoteSessionToken, command, signal, () => requestedStop || settled,
      ),
      remoteUiRead: (endpoint, payload, signal) => endpoint === 'asset/read' || endpoint === 'asset/describe'
        ? this.remoteUiAssetRead(viewOrigin, bootstrapCookie, remoteUiToken, endpoint, payload, signal,
          () => requestedStop || settled, assetCache)
        : this.remoteUiRead(viewOrigin, remoteUiToken, endpoint, payload, signal,
          () => requestedStop || settled),
      remoteUiStream: (endpoint, payload, signal) => openRemoteUiWorkerStream(
        viewOrigin, remoteUiToken, endpoint, payload, signal, () => requestedStop || settled),
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

  private async inspectWorkspaceModelSelection(
    viewOrigin: string,
    token: string,
    target: HostWorkspaceModelSelectionTarget,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<HostWorkspaceModelSelection> {
    signal.throwIfAborted()
    if (stopped()) throw new HostAuthorityError('unavailable')
    const active = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const response = await fetch(`${viewOrigin}/internal/desktop-workspace-model-selection`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(target), signal: active,
    })
    return this.readPrivateResponse(response, active, signal, stopped, 8192, (bytes) => {
      const result = parseHostWorkspaceModelSelection(JSON.parse(bytes.toString('utf8')))
      if (result.workspace_id !== target.workspace_id || result.session_id !== target.session_id) {
        throw new HostAuthorityError('profile_mismatch')
      }
      return result
    }, 'await')
  }

  private async collaborationAnalysis(
    origin: string,
    token: string,
    command: HostRemoteSessionJson,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<HostRemoteSessionJson> {
    const active = AbortSignal.any([signal, AbortSignal.timeout(35000)])
    active.throwIfAborted()
    if (stopped()) throw new HostAuthorityError('unavailable')
    const body = JSON.stringify(parseHostRemoteSessionJson(command))
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new HostAuthorityError('invalid_input')
    const response = await fetch(`${origin}/internal/desktop-collaboration-analysis`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      signal: active,
    })
    return this.readPrivateResponse(response, active, signal, stopped, 128 * 1024, (bytes) => {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 ||
        !Object.hasOwn(parsed, 'value')
      )
        throw new HostAuthorityError('unavailable')
      return parseHostRemoteSessionJson((parsed as { value: unknown }).value)
    }, 'detach')
  }

  private async receiveCollaborationDelivery(
    origin: string,
    token: string,
    command: HostCollaborationDeliveryCapsule,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<HostRemoteSessionJson> {
    const active = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    active.throwIfAborted()
    if (stopped()) throw new HostAuthorityError('unavailable')
    // The Profile validates the full delivery schema. Control JSON's 32 KiB string cap excludes replies.
    const body = JSON.stringify(command)
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new HostAuthorityError('invalid_input')
    const response = await fetch(`${origin}/internal/desktop-collaboration-delivery`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body, signal: active,
    })
    return this.readPrivateResponse(response, active, signal, stopped, 8192,
      bytes => parseHostRemoteSessionJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
      'detach')
  }

  private async inspectCollaborationSource(
    viewOrigin: string,
    token: string,
    target: HostCollaborationSourceTarget,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<HostCollaborationSourceDescriptor> {
    return this.readSource(viewOrigin,token,target,signal,stopped,'/internal/desktop-collaboration-source',8192,parseHostCollaborationSourceDescriptor,result=>result)
  }

  private readCollaborationSourceSnapshot(
    viewOrigin: string,
    token: string,
    target: HostCollaborationSourceTarget,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<HostCollaborationSourceSnapshot> {
    return this.readSource(
      viewOrigin,
      token,
      target,
      signal,
      stopped,
      '/internal/desktop-collaboration-source-snapshot',
      2 * 1024 * 1024,
      parseHostCollaborationSourceSnapshot,
      result => result.descriptor,
    )
  }

  private async readSource<T>(
    viewOrigin: string,
    token: string,
    target: HostCollaborationSourceTarget,
    signal: AbortSignal,
    stopped: () => boolean,
    path: string,
    maxBytes: number,
    parse: (value: unknown) => T,
    coordinates: (value: T) => HostCollaborationSourceTarget,
  ): Promise<T> {
    const active = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    active.throwIfAborted()
    if (stopped()) throw new HostAuthorityError('unavailable')
    const response = await fetch(`${viewOrigin}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(target),
      signal: active,
    })
    return this.readPrivateResponse(response, active, signal, stopped, maxBytes, (bytes) => {
      const result = parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      const selected = coordinates(result)
      if (
        selected.workspace_id !== target.workspace_id ||
        selected.session_id !== target.session_id ||
        selected.source_message_id !== target.source_message_id ||
        selected.source_revision !== target.source_revision
      ) {
        throw new HostAuthorityError('profile_mismatch')
      }
      return result
    }, 'detach')
  }

  /** Retain each read's deadline, owner cancellation, byte budget and reader teardown policy. */
  private async readPrivateResponse<T>(
    response: Response,
    active: AbortSignal,
    ownerSignal: AbortSignal,
    stopped: () => boolean,
    maxBytes: number,
    parse: (bytes: Buffer) => T,
    cancellation: 'await' | 'detach',
  ): Promise<T> {
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new HostAuthorityError('unavailable')
    }
    const reader = response.body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if ((bytes += chunk.value.byteLength) > maxBytes) throw new HostAuthorityError('unavailable')
        chunks.push(chunk.value)
      }
      active.throwIfAborted()
      if (stopped()) throw new HostAuthorityError('unavailable')
      return parse(Buffer.concat(chunks))
    } catch (error) {
      if (error instanceof HostAuthorityError || ownerSignal.aborted) throw error
      throw new HostAuthorityError('unavailable')
    } finally {
      if (cancellation === 'await') await reader.cancel()
      else void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private async remoteSession(
    viewOrigin: string,
    token: string,
    command: HostRemoteSessionCommand,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<HostRemoteSessionJson> {
    return await this.remoteJson(viewOrigin, token, 'desktop-remote-session', command, signal, stopped) as HostRemoteSessionJson
  }

  private async remoteUiRead(
    viewOrigin: string,
    token: string,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<unknown> {
    const value = await this.remoteJson(viewOrigin, token, 'desktop-remote-ui', { endpoint, payload }, signal, stopped)
    return endpoint === 'boot/injections' ? remoteBootReferences(value) : value
  }

  private async remoteJson(
    viewOrigin: string,
    token: string,
    route: 'desktop-remote-session' | 'desktop-remote-ui',
    payload: unknown,
    signal: AbortSignal,
    stopped: () => boolean,
  ): Promise<unknown> {
    if (stopped()) throw new HostAuthorityError('unavailable')
    const response = await fetch(`${viewOrigin}/internal/${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new HostAuthorityError(route === 'desktop-remote-session' && response.status === 409
        ? 'conflict' : route === 'desktop-remote-session' && response.status === 429
          ? 'busy' : 'unavailable')
    }
    const body = await response.text()
    if (Buffer.byteLength(body) > 512 * 1024) throw new HostAuthorityError('unavailable')
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new HostAuthorityError('unavailable') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'value')) {
      throw new HostAuthorityError('unavailable')
    }
    return (parsed as { value: unknown }).value
  }

  private async remoteUiAssetRead(
    viewOrigin: string,
    cookie: { readonly name: string; readonly value: string },
    token: string,
    endpoint: 'asset/read' | 'asset/describe',
    payload: unknown,
    signal: AbortSignal,
    stopped: () => boolean,
    cache: { current?: { readonly url: string; readonly bytes: Buffer } },
  ): Promise<{ readonly bytes: string; readonly total: number } | { readonly sha256: string; readonly total: number }> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HostAuthorityError('invalid_input')
    const args = (payload as { args?: unknown }).args
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new HostAuthorityError('invalid_input')
    const selected = args as Record<string, unknown>
    if (Object.keys(selected).length !== (endpoint === 'asset/read' ? 2 : 1)
      || typeof selected.url !== 'string'
      || (endpoint === 'asset/read' && (!Number.isSafeInteger(selected.offset)
        || (selected.offset as number) < 0
        || (selected.offset as number) > REMOTE_UI_ASSET_MAX_BYTES))) throw new HostAuthorityError('invalid_input')
    let url: URL
    try { url = new URL(selected.url, viewOrigin) } catch { throw new HostAuthorityError('invalid_input') }
    if (url.origin !== viewOrigin || url.hash !== '' || !url.pathname.startsWith('/plugins/')
      || selected.url !== url.pathname + url.search) throw new HostAuthorityError('invalid_input')
    const boot = await this.remoteUiRead(viewOrigin, token, 'boot/injections', { args: {} }, signal, stopped)
    if (!boot || typeof boot !== 'object' || Array.isArray(boot)) throw new HostAuthorityError('unavailable')
    const injections = (boot as { injections?: unknown }).injections
    if (!Array.isArray(injections) || !injections.some((row: unknown) =>
      row && typeof row === 'object' && !Array.isArray(row)
      && ((row as { kind?: unknown }).kind === 'script-src' || (row as { kind?: unknown }).kind === 'script-preload')
      && (row as { src?: unknown }).src === selected.url)) throw new HostAuthorityError('invalid_input')
    if (stopped()) throw new HostAuthorityError('unavailable')
    let body = cache.current?.url === selected.url ? cache.current.bytes : undefined
    if (body === undefined) {
      const response = await fetch(url, {
        headers: { cookie: `${cookie.name}=${cookie.value}` }, redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      })
      if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'text/javascript'
        || !response.body) { await response.body?.cancel(); throw new HostAuthorityError('unavailable') }
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength
          if (size > REMOTE_UI_ASSET_MAX_BYTES) throw new HostAuthorityError('unavailable')
          chunks.push(Buffer.from(chunk))
        }
      } catch (error) {
        await response.body.cancel().catch(() => {})
        throw error
      }
      body = Buffer.concat(chunks, size)
      if (stopped() || signal.aborted) throw new HostAuthorityError('unavailable')
      cache.current = { url: selected.url, bytes: body }
    }
    if (stopped() || signal.aborted) throw new HostAuthorityError('unavailable')
    if (endpoint === 'asset/describe') {
      return { sha256: createHash('sha256').update(body).digest('hex'), total: body.byteLength }
    }
    if ((selected.offset as number) > body.byteLength) throw new HostAuthorityError('invalid_input')
    const bytes = body.subarray(selected.offset as number,
      (selected.offset as number) + REMOTE_UI_ASSET_CHUNK_BYTES)
    return { bytes: bytes.toString('base64url'), total: body.byteLength }
  }
}
