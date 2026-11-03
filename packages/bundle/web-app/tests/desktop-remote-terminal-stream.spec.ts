import { describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HostRemoteSessionCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopSessionControl } from '../src/desktop-session-control.ts'
import { DesktopRemoteTerminalStreams } from '../src/desktop-remote-terminal-stream.ts'

type Command = Extract<HostRemoteSessionCommand, { operation: 'terminal.apply' }>
function fixture(method: 'follow' | 'retain' = 'follow') {
  let now = 1000
  const control = new DesktopSessionControl(() => now)
  const owner = { kind: 'remote' as const, id: '123e4567-e89b-42d3-a456-426614174001' }
  const state = control.acquire('s', owner, { takeover: false })
  if (!('claim' in state)) throw new Error('claim missing')
  const command: Command = { operation: 'terminal.apply', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
    session_id: 's', control: { controller_id: owner.id, generation: state.claim.generation, epoch: state.claim.epoch },
    request: { sessionId: 's', method, args: method === 'follow' ? { agentId: 's', id: 't', attachmentId: 'a' } : { sessionId: 's', id: 't' } } }
  return { command, control, manager: new DesktopRemoteTerminalStreams(control, () => now), advance: (value: number) => { now += value } }
}
const gateway = (stream: TypertGateway['stream']) => Object.assign({} as TypertGateway, { stream })

describe('native terminal stream permits', () => {
  it('consumes once, preserves exact Gateway args, and refuses changed control before further output', async () => {
    for (const method of ['follow', 'retain'] as const) {
      const f = fixture(method)
      const permit = f.manager.issue(f.command)
      f.command.request.args.id = 'changed-after-issue'
      const stream = vi.fn(async (_request: Parameters<TypertGateway['stream']>[0]) => (async function* () { yield { type: 'ready' }; yield { type: 'output', data: 'secret' } })())
      const opened = f.manager.open(gateway(stream), permit.grantId, new AbortController().signal)
      expect((await opened.next()).value).toEqual({ type: 'ready' })
      expect(stream.mock.calls[0]?.[0]).toMatchObject({ namespace: 'terminal', method,
        args: method === 'follow' ? { agentId: 's', id: 't', attachmentId: 'a' } : { sessionId: 's', id: 't' } })
      expect(f.control.takeoverBrowser('s', f.command.control.epoch).outcome).toBe('controlled')
      await expect(opened.next()).rejects.toThrow('control lost')
      await expect(f.manager.open(gateway(stream), permit.grantId, new AbortController().signal).next()).rejects.toThrow('unavailable')
    }
  })
  it('expires and bounds unused permits, rejecting control loss without starting a terminal', async () => {
    const f = fixture()
    const permits = Array.from({ length: 16 }, () => f.manager.issue(f.command))
    expect(() => f.manager.issue(f.command)).toThrow('full')
    f.advance(10_000)
    const next = f.manager.issue(f.command)
    const never = gateway(async () => (async function* () { throw new Error('must not open') })())
    await expect(f.manager.open(never, permits[0]?.grantId ?? 'missing', new AbortController().signal).next()).rejects.toThrow('unavailable')
    f.advance(20_001)
    await expect(f.manager.open(never, next.grantId, new AbortController().signal).next()).rejects.toThrow('unavailable')
    expect(() => f.manager.issue(f.command)).toThrow('control lost')
    expect(() => f.manager.issue({ ...f.command, request: { ...f.command.request, method: 'list' } })).toThrow('method denied')
  })
  it('caps active attachments and releases capacity on end or cancellation', async () => {
    const f = fixture()
    const stream = gateway(async () => (async function* () { yield 1; yield 2 })())
    const opened = Array.from({ length: 8 }, () => f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal))
    await Promise.all(opened.map(value => value.next()))
    await expect(f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal).next()).rejects.toThrow('unavailable')
    await opened[0]?.return(undefined)
    const accepted = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    const values: unknown[] = []
    for await (const value of accepted) values.push(value)
    expect(values).toEqual([1, 2])
    await Promise.all(opened.slice(1).map(value => value.return(undefined)))
    const controller = new AbortController(); controller.abort(Error('closed view'))
    await expect(f.manager.open(stream, f.manager.issue(f.command).grantId, controller.signal).next()).rejects.toThrow('closed view')
  })
  it('cancels an idle attachment when control expires, including the pre-first-frame hold', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      let observed: AbortSignal | undefined
      const stream = gateway(async request => (async function* () {
        const signal = request.signal
        if (!signal) throw new Error('missing signal')
        observed = signal
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'))
          }, { once: true })
        })
      })())
      const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
      const pending = opened.next()
      const rejected = expect(pending).rejects.toThrow('control lost')
      expect(f.control.takeoverBrowser('s', f.command.control.epoch).outcome).toBe('held_elsewhere')
      f.advance(30_001)
      await vi.advanceTimersByTimeAsync(1000)
      await rejected
      expect(observed?.aborted).toBe(true)
      expect(f.control.takeoverBrowser('s', f.command.control.epoch).outcome).toBe('controlled')
    } finally { vi.useRealTimers() }
  })
})
