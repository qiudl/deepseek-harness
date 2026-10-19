/** Real Host terminal control and stream without a browser page owner. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DesktopRemoteTerminalStreams } from '../../../packages/bundle/web-app/src/desktop-remote-terminal-stream.ts'
import { DesktopRemoteSessionExecutor } from '../../../packages/bundle/web-app/src/desktop-remote-session.ts'
import { DesktopSessionControl } from '../../../packages/bundle/web-app/src/desktop-session-control.ts'
import { DesktopRemoteUiStreamExecutor } from '../../../packages/bundle/web-app/src/desktop-remote-ui-stream.ts'
import type { WorkbenchTerminalRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold
let sessionId: SessionId
beforeAll(async () => {
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  const fixture = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
  sessionId = await seedSession(scaffold, fixture, 'native-workbench-terminal-history')
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'iPhone 终端验收')
  await workspace.attachSession(sessionId)
}, 120000)
afterAll(async () => { await scaffold?.close() })

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
    while (!/\r?\nREQ6049_NATIVE_TERMINAL\r?\n/u.test(output)) {
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
