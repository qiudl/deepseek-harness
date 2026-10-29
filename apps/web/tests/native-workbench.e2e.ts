import { randomUUID } from 'node:crypto'
import { DesktopRemoteTerminalStreams } from '../../../packages/bundle/web-app/src/desktop-remote-terminal-stream.ts'
import { DesktopRemoteSessionExecutor } from '../../../packages/bundle/web-app/src/desktop-remote-session.ts'
import { DesktopSessionControl } from '../../../packages/bundle/web-app/src/desktop-session-control.ts'
import type { WorkbenchTerminalRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopRemoteUiStreamExecutor } from '../../../packages/bundle/web-app/src/desktop-remote-ui-stream.ts'
import { createWebConnectionRpc } from '@deepseek-ai/dsh-client-connection/src/client/rpc.ts'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type { SessionId } from '@deepseek-ai/dsh-session'
/** Real shipped Web composition inside the App's opaque, bundled document. */
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify, stripVTControlCharacters } from 'node:util'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold
let browser: Browser
let page: Page
let sessionId: SessionId
let otherSessionId: SessionId
let buildDirectory: string
const screenshotDirectory = process.env.DSH_NATIVE_WORKBENCH_SCREENSHOT_DIR
const duetTargets: unknown[] = []
const dictationTargets: unknown[] = []
const dictations = new Map<string | number, (text: string | null) => void>()
let dictationAborts = 0
const streams = new Map<string | number, AbortController>()
const failures: string[] = []
const requests: { path: string; done?: number; bytes?: number }[] = []
const nativeTasks = new Set<Promise<void>>()
beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'dsh-native-workbench-'))
  // Exercise this checkout's real App document, including CSP hashes, in clean CI.
  await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), 'build',
      '--config', 'vite.native.config.ts', '--mode', 'native', '--outDir', buildDirectory],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  const fixture = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
  sessionId = await seedSession(scaffold, fixture, 'native-workbench-history')
  otherSessionId = await seedSession(scaffold, fixture, 'native-workbench-other')
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'iPhone 验收')
  await workspace.attachSession(sessionId)
  await workspace.attachSession(otherSessionId)
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  page.on('pageerror', error => failures.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await page.exposeFunction('nativeSend', async (frame: {
    t: string
    id: string | number
    method?: string
    url?: string
    headers?: Record<string, string>
    bytes?: number[]
    endpoint?: string
    payload?: unknown
  }) => {
    const task = (async (): Promise<void> => {
      const send = async (value: object, bytes?: Uint8Array): Promise<void> => {
        await page.evaluate(({ value, encoded }) => {
          const receiver = Reflect.get(window, 'nativeReceive') as (value: object) => void
          const body = encoded === undefined ? undefined : Uint8Array.from(atob(encoded), char => char.charCodeAt(0)).buffer
          receiver({ ...value, ...(body === undefined ? {} : { body }) })
        }, { value, encoded: bytes && Buffer.from(bytes).toString('base64') })
      }
      if (frame.t === 'abort') {
        streams.get(frame.id)?.abort(); streams.delete(frame.id)
        if (dictations.has(frame.id)) { dictationAborts++; dictations.get(frame.id)?.(null); dictations.delete(frame.id) }
        return
      }
      if (frame.t === 'stream-open' && frame.endpoint) {
        const abort = new AbortController()
        streams.set(frame.id, abort)
        try {
          const uplink = (async function* () { /* No client stream items in this reading scenario. */ })()
          const source = await scaffold.ctx.typertGateway.wireStream.open(frame.endpoint, frame.payload, uplink, undefined, abort.signal)
          for await (const value of source) await send({ t: 'stream-item', id: frame.id, value })
          if (!abort.signal.aborted) await send({ t: 'stream-end', id: frame.id })
        } catch (error) {
          if (!abort.signal.aborted) await send({ t: 'stream-error', id: frame.id,
            failure: { kind: 'remote', ...scaffold.ctx.typertGateway.wireStream.failure(error) } })
        } finally { streams.delete(frame.id) }
        return
      }
      if (frame.t !== 'req' || !frame.url) return
      const path = new URL(frame.url).pathname + new URL(frame.url).search
      const observed: { path: string; done?: number; bytes?: number } = { path }
      requests.push(observed)
      let response: Response
      if (path === '/__boot__') response = Response.json({ injections: scaffold.ctx.webServer.collectIndexInjections() })
      else if (path === '/__native_workbench__') response = Response.json({ schema: 'dsh-native-workbench/v1', duet: true, draft: false,
        personalInbox: false, botPending: false, dictation: true })
      else if (path === '/__native_dictation__') {
        dictationTargets.push(JSON.parse(Buffer.from(frame.bytes ?? []).toString('utf8')))
        const text = await new Promise<string | null>((resolve) => { dictations.set(frame.id, resolve) })
        dictations.delete(frame.id)
        response = Response.json({ ok: true, value: { text } })
      }
      else if (path === '/__native_duet__') {
        const target: unknown = JSON.parse(Buffer.from(frame.bytes ?? []).toString('utf8'))
        duetTargets.push(target)
        response = Response.json({ ok: true, value: { accepted: true } })
      }
      else if (path === '/__account__') response = Response.json(null)
      // Signed remote assets omit optional development source maps.
      else if (path.includes('.js.map')) response = new Response(null, { status: 404 })
      else response = await scaffold.hostFetch(path, { ...(frame.method ? { method: frame.method } : {}),
        ...(frame.headers ? { headers: frame.headers } : {}),
        ...(frame.bytes ? { body: Buffer.from(frame.bytes) } : {}) })
      const bytes = new Uint8Array(await response.arrayBuffer())
      await send({ t: 'res', id: frame.id, status: response.status, headers: Object.fromEntries(response.headers) }, bytes)
      observed.done = response.status; observed.bytes = bytes.length
    })()
    nativeTasks.add(task)
    return task.finally(() => { nativeTasks.delete(task) })
  })
  const parentPath = join(scaffold.workspaceCwd, 'native-parent.html')
  await writeFile(parentPath, '<!doctype html><body></body>')
  await page.goto(pathToFileURL(parentPath).href)
  const nativeDocument = await readFile(join(buildDirectory, 'native.html'), 'utf8')
  await page.evaluate((html) => {
    const frame = document.createElement('iframe')
    frame.sandbox.add('allow-scripts')
    frame.style.cssText = 'border:0;width:100vw;height:100vh'
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      const ready = event.data
      if (!ready || typeof ready !== 'object' || !('kind' in ready) || !('nonce' in ready) || typeof ready.nonce !== 'string') return
      if (event.source !== frame.contentWindow || event.origin !== 'null' || ready.kind !== 'ready') return
      const channel = new MessageChannel()
      Reflect.set(window, 'nativeReceive', (value: object) => { channel.port1.postMessage(value) })
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data
        if (!value || typeof value !== 'object') return
        const body = 'body' in value ? value.body : undefined
        const send = Reflect.get(window, 'nativeSend') as (value: object) => Promise<void>
        void send({ ...value, ...(body instanceof ArrayBuffer ? { bytes: [...new Uint8Array(body)] } : {}) })
      }
      frame.contentWindow!.postMessage({ schema: 'dsh-remote-frame/v1', kind: 'connect', nonce: ready.nonce,
        assetOrigin: 'https://ui.example.test' }, '*', [channel.port2])
    })
    document.body.style.margin = '0'
    frame.srcdoc = html
    document.body.append(frame)
  }, nativeDocument)
}, 120000)
afterAll(async () => {
  const child = page?.frames().find(frame => frame.parentFrame())
  if (child && !child.isDetached()) await child.evaluate(() => { window.dispatchEvent(new Event('pagehide')) })
  for (const complete of dictations.values()) complete(null)
  dictations.clear()
  for (const abort of streams.values()) abort.abort()
  await Promise.allSettled([...nativeTasks])
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally {
      if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
    }
  }
})
it('mounts shared mobile controls from real Host injections without parent access', async () => {
  const frame = page.frameLocator('iframe')
  onTestFailed(async () => {
    console.error(failures)
    console.error(requests)
    console.error(await frame.locator('body').innerText())
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true })
      await page.screenshot({ path: join(screenshotDirectory, 'failure.png') })
    }
  })
  await frame.getByRole('button', { name: '继续', exact: true }).click({ timeout: 60000 })
  await frame.getByRole('button', { name: '打开导航', exact: true }).click()
  await frame.getByRole('dialog', { name: '手机导航' }).getByRole('button', { name: '会话', exact: true }).click()
  await frame.getByRole('treeitem').filter({ has: frame.getByText('iPhone 验收', { exact: true }) }).click()
  await frame.locator(`[data-row-key="session:${sessionId}"]`).click()
  await frame.locator('[data-chat-flow-kind="user"]').first().waitFor()
  await frame.getByTestId('native-duet-input').click()
  await frame.getByRole('menuitem', { name: '快聊', exact: true }).click()
  await expect.poll(() => duetTargets).toEqual([{ sessionId }])
  expect(await frame.locator('[data-chat-flow-kind="turn-process"]').count()).toBe(0)
  const input = frame.locator('[contenteditable="true"]').first()
  await input.fill('返回后保留的草稿')
  await frame.getByRole('tab', { name: '思考过程', exact: true }).click()
  await frame.locator('[data-trajectory-scroll]').waitFor()
  await frame.getByRole('tab', { name: '对话', exact: true }).click()
  expect(await input.innerText()).toBe('返回后保留的草稿')
  expect(await frame.locator('[data-chat-flow-kind="user"]').first().innerText()).toContain('你')
  expect(await frame.locator('[data-chat-flow-kind="assistant-step"]').last().innerText()).toContain('Agent')
  expect(await frame.locator('html').getAttribute('data-dsh-native')).toBe('true')
  expect(await frame.locator('body').innerText()).not.toContain('remote web:')
  expect(failures).toEqual([])
  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true })
    await page.screenshot({ path: join(screenshotDirectory, 'conversation.png') })
  }
})

it('dictates into the existing editor without sending, preserves concurrent edits and cancels when leaving chat', async () => {
  const frame = page.frameLocator('iframe'), input = frame.locator('[data-composer-input][contenteditable="true"]').first()
  const promptCount = () => requests.filter(item => item.path === '/api/session/prompt').length
  const before = promptCount()
  const finish = (text: string | null): void => {
    const complete = [...dictations.values()].at(-1)
    if (!complete) throw Error('no active native recording')
    complete(text)
  }
  const record = async (): Promise<void> => {
    const previous = dictationTargets.length
    await frame.getByTestId('native-duet-input').click()
    await frame.getByRole('menuitem', { name: '语音转写', exact: true }).click()
    await expect.poll(() => dictationTargets.length).toBe(previous + 1)
    expect(dictationTargets.at(-1)).toEqual({ sessionId })
  }
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await input.fill(`原草稿${width} `)
    await frame.getByTestId('native-duet-input').click()
    const menu = frame.getByRole('menu', { name: '语音输入' })
    const bounds = await menu.boundingBox()
    expect(bounds?.x).toBeGreaterThanOrEqual(16)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 16)
    expect((await menu.ariaSnapshot()).trim()).toBe((await readFile(new URL('./expected/native-dictation/menu.yml', import.meta.url), 'utf8')).trim())
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `voice-menu-${width}.png`) })
    await frame.getByRole('menuitem', { name: '语音转写', exact: true }).click()
    await expect.poll(() => dictations.size).toBe(1)
    finish(`可编辑转写${width}`)
    await expect.poll(async () => input.innerText()).toBe(`原草稿${width} 可编辑转写${width}`)
    expect(await frame.locator('html').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true)
    expect(promptCount()).toBe(before)
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `dictation-draft-${width}.png`) })
  }
  const unchanged = await input.innerText()
  await record(); finish(null)
  await expect.poll(() => dictations.size).toBe(0)
  expect(await input.innerText()).toBe(unchanged)
  await record(); await input.fill('用户继续编辑的新草稿'); finish('不可覆盖的新转写')
  await frame.getByRole('status').filter({ hasText: '输入内容已变化' }).waitFor()
  expect(await input.innerText()).toBe('用户继续编辑的新草稿')
  expect(await frame.getByRole('status').filter({ hasText: '输入内容已变化' }).innerText()).toContain('不可覆盖的新转写')
  if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, 'dictation-conflict-430.png') })
  await record()
  const aborted = dictationAborts
  await frame.getByRole('button', { name: '打开导航', exact: true }).click()
  await frame.getByRole('dialog', { name: '手机导航' }).getByRole('button', { name: '会话', exact: true }).click()
  await frame.locator(`[data-row-key="session:${otherSessionId}"]`).click()
  await expect.poll(() => dictationAborts).toBe(aborted + 1)
  await frame.getByRole('button', { name: '打开导航', exact: true }).click()
  await frame.getByRole('dialog', { name: '手机导航' }).getByRole('button', { name: '会话', exact: true }).click()
  await frame.locator(`[data-row-key="session:${sessionId}"]`).click()
  expect(await input.innerText()).toBe('用户继续编辑的新草稿')
  expect(promptCount()).toBe(before); expect(failures).toEqual([])
})


it('reads actual Host workspace bytes through the native file stream and existing RPC decoder', async () => {
  const binary = new Uint8Array(70 * 1024).map((_, index) => index % 256)
  await writeFile(join(scaffold.workspaceCwd, 'native-fixture.bin'), binary)
  const handler = scaffold.ctx.connection.createSharedFetchHandler('/api')
  const executor = new DesktopRemoteUiStreamExecutor(scaffold.ctx.typertGateway, undefined, request => handler.fetch(request))
  const rpc = createWebConnectionRpc(async (_path, init) => {
    const request = new Request('http://localhost', init)
    const envelope = await request.json() as { rpcId: string; method: string; payload: { args: object } }
    const source = await executor.open('workbench/read', { args: {
      endpoint: envelope.method, rpcId: envelope.rpcId, args: envelope.payload.args,
    } }, request.signal)
    let contentType = ''
    const chunks: Buffer[] = []
    let length = 0
    for await (const value of source) {
      const item = value as { type: string; contentType: string; bytes: string; offset: number; totalBytes: number }
      if (item.type === 'head') contentType = item.contentType
      else if (item.type === 'bytes') {
        expect(item.offset).toBe(length)
        const chunk = Buffer.from(item.bytes, 'base64url')
        chunks.push(chunk); length += chunk.length
      } else expect(item.totalBytes).toBe(length)
    }
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/u)
    return new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } })
  })
  const result = await rpc.call('/api', 'workspaceFiles/readBytes', { args: {
    workspaceFileScopeId: sessionId, path: 'native-fixture.bin', options: {},
  } })
  expect(result).toMatchObject({ ok: true, value: { data: binary, bytes: binary.length, eof: true } })
})


it('follows real Host file changes and releases the watcher on page cancellation', async () => {
  const path = join(scaffold.workspaceCwd, 'native-watch.txt')
  await writeFile(path, 'before')
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
  const executor = new DesktopRemoteUiStreamExecutor(scaffold.ctx.typertGateway)
  const stream = await executor.open('workspaceFiles/changes', {
    args: { workspaceFileScopeId: sessionId, path: 'native-watch.txt' },
  }, signal)
  const iterator = stream[Symbol.asyncIterator]()
  try {
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { kind: 'ready' } })
    await writeFile(path, 'updated by Host')
    await expect(iterator.next()).resolves.toMatchObject({ done: false,
      value: { kind: 'change', change: { absolutePath: path } } })
  } finally { controller.abort(); await iterator.return?.() }
})

it('operates a real Host shell with controlled input, streamed output and attachment cleanup', async () => {
  const control = new DesktopSessionControl()
  const owner = { kind: 'remote' as const, id: randomUUID() }
  const state = control.acquire(sessionId, owner, { takeover: false })
  if (!('claim' in state)) throw new Error('missing terminal control')
  const proof = { controller_id: owner.id, generation: state.claim.generation, epoch: state.claim.epoch }
  const credential = { kind: owner.kind, id: owner.id, generation: state.claim.generation, epoch: state.claim.epoch }
  const terminalStreams = new DesktopRemoteTerminalStreams(control)
  const actions = new DesktopRemoteSessionExecutor(scaffold.ctx.typertGateway, undefined, control, terminalStreams)
  const streams = new DesktopRemoteUiStreamExecutor(scaffold.ctx.typertGateway, undefined, undefined, terminalStreams)
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
  const renewal = setInterval(() => {
    if (control.renew(sessionId, credential).outcome !== 'controlled') {
      controller.abort(new Error('terminal control renewal failed'))
    }
  }, 5000)
  renewal.unref()
  const terminalId = randomUUID(), attachmentId = randomUUID()
  const invoke = (method: WorkbenchTerminalRequest['method'], args: WorkbenchTerminalRequest['args']) => actions.execute({
    operation: 'terminal.apply', command_id: randomUUID() as never, session_id: sessionId, control: proof,
    request: { sessionId, method, args },
  }, signal)
  let iterator: AsyncIterator<unknown> | undefined
  try {
    await expect(invoke('create', { agentId: sessionId, request: { id: terminalId, cols: 80, rows: 24 } }))
      .resolves.toMatchObject({ ok: true, value: { id: terminalId, state: 'running' } })
    const granted = await invoke('follow', { agentId: sessionId, id: terminalId, attachmentId })
    if (!granted || typeof granted !== 'object' || Array.isArray(granted) || !('value' in granted)
      || !granted.value || typeof granted.value !== 'object' || Array.isArray(granted.value)) throw new Error('missing terminal permit')
    const source = await streams.open('terminal/stream', { args: granted.value }, signal)
    iterator = source[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot', info: { id: terminalId } } })
    await expect(invoke('resize', { agentId: sessionId, id: terminalId, attachmentId, cols: 100, rows: 30 })).resolves.toEqual({ ok: true })
    await expect(invoke('rename', { agentId: sessionId, id: terminalId, title: 'iPhone shell' })).resolves.toEqual({ ok: true })
    await expect(invoke('write', { agentId: sessionId, id: terminalId, attachmentId, data: 'echo REQ6049_NATIVE_TERMINAL\n' })).resolves.toEqual({ ok: true })
    let output = ''
    while (!stripVTControlCharacters(output).replaceAll('\r', '').split('\n').includes('REQ6049_NATIVE_TERMINAL')) {
      const next = await iterator.next()
      if (next.done) throw new Error('terminal closed before echo')
      const value = next.value as { type: string; data?: string }
      if (value.type === 'output') output += value.data ?? ''
    }
    const listed = await invoke('list', { sessionId })
    if (!listed || typeof listed !== 'object' || Array.isArray(listed) || !('value' in listed)
      || !Array.isArray(listed.value)) throw new Error('terminal list missing')
    expect((listed.value as unknown[]).some(item => item !== null && typeof item === 'object'
      && 'id' in item && item.id === terminalId && 'title' in item && item.title === 'iPhone shell'
      && 'cols' in item && item.cols === 100 && 'rows' in item && item.rows === 30)).toBe(true)
    controller.abort()
    await iterator.return?.()
    await expect.poll(async () => {
      const items: unknown = await scaffold.ctx.typertGateway.invoke({ namespace: 'terminal', method: 'list', args: { sessionId }, signal: new AbortController().signal })
      return Array.isArray(items) && (items as unknown[]).some(item => item !== null && typeof item === 'object' && 'id' in item
        && item.id === terminalId && !Object.hasOwn(item, 'controllerId'))
    }).toBe(true)
  } finally {
    clearInterval(renewal)
    controller.abort()
    await iterator?.return?.()
    await scaffold.ctx.typertGateway.invoke({ namespace: 'terminal', method: 'close', args: { agentId: sessionId, id: terminalId }, signal: new AbortController().signal })
  }
}, 70000)
