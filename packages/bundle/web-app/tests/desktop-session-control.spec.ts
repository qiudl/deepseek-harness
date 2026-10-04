import { describe, expect, it } from 'vitest'
import { DesktopSessionControl, DesktopSessionControlBusyError } from '../src/desktop-session-control.ts'

describe('Desktop Session control authority', () => {
  it('rejects invalid limits, takeover epochs, and Session identifiers', () => {
    expect(() => new DesktopSessionControl(Date.now, 4_999)).toThrow('invalid lease duration')
    expect(() => new DesktopSessionControl(Date.now, 30_000, 0)).toThrow('invalid claim capacity')
    const control = new DesktopSessionControl()
    expect(() => control.takeoverBrowser('session-1', 0)).toThrow('invalid expected epoch')
    expect(() => control.status('../outside', { kind: 'remote', id: 'web-1' })).toThrow('invalid Session id')
    for (const args of [{ request: null }, { request: [] }, { request: { sessionId: 4 } },
      { request: { sessionId: '../outside' } }]) {
      expect(control.admitBrowserInvoke('session/cancel', args)).toBeUndefined()
    }
    expect(control.status('session-1', { kind: 'remote', id: 'web-1' }).outcome).toBe('uncontrolled')
  })

  it('holds an expired claim through overlapping writes and releases each disposer once', () => {
    let now = 1_000
    const control = new DesktopSessionControl(() => now, 5_000)
    const owner = { kind: 'remote' as const, id: 'web-1' }
    const initial = control.acquire('session-1', owner, { takeover: false })
    if (!('claim' in initial)) throw new Error('missing initial claim')
    const finishFirst = control.beginWrite('session-1', initial.claim)
    const finishSecond = control.beginWrite('session-1', initial.claim)
    now += 5_000
    expect(control.status('session-1', owner).outcome).toBe('controlled')
    const other = { kind: 'remote' as const, id: 'web-2' }
    expect(control.acquire('session-1', other, { takeover: true,
      expectedEpoch: initial.claim.epoch }).outcome).toBe('held_elsewhere')
    expect(control.renew('session-1', initial.claim).outcome).toBe('controlled')
    finishFirst()
    finishFirst()
    expect(control.status('session-1', owner).outcome).toBe('controlled')
    finishSecond()
    expect(control.acquire('session-1', other, { takeover: true,
      expectedEpoch: initial.claim.epoch }).outcome).toBe('controlled')
  })

  it('reports an absent lease as uncontrolled and rejects a released lease on renewal', () => {
    const control = new DesktopSessionControl()
    const owner = { kind: 'remote' as const, id: 'web-1' }
    const absent = { ...owner, generation: control.generation, epoch: 1 }
    expect(control.renew('session-1', absent)).toMatchObject({ outcome: 'uncontrolled', epoch: 0 })
    const claimed = control.acquire('session-1', owner, { takeover: false })
    if (!('claim' in claimed)) throw new Error('missing claim')
    expect(control.release('session-1', claimed.claim)).toBe(true)
    expect(control.renew('session-1', claimed.claim).outcome).toBe('epoch_stale')
  })

  it('admits local browser writes until a remote client explicitly takes over', () => {
    const control = new DesktopSessionControl()
    const args = { request: { sessionId: 'session-1', content: [] } }
    control.admitBrowserInvoke('session/list', args)
    expect(control.status('session-1', { kind: 'local', id: 'desktop-browser' }).outcome)
      .toBe('uncontrolled')
    const finishLocalWrite = control.admitBrowserInvoke('session/prompt', args)
    const local = control.status('session-1', { kind: 'local', id: 'desktop-browser' })
    if (!('claim' in local)) throw new Error('missing local claim')
    expect(control.acquire('session-1', { kind: 'remote', id: 'web-1' },
      { takeover: true, expectedEpoch: local.claim.epoch }).outcome).toBe('held_elsewhere')
    finishLocalWrite?.()
    const remote = control.acquire('session-1', { kind: 'remote', id: 'web-1' },
      { takeover: true, expectedEpoch: local.claim.epoch })
    expect(remote.outcome).toBe('controlled')
    expect(() => { control.admitBrowserInvoke('session/cancel', args) }).toThrow('another client')
    expect(() => { control.admitBrowserWrite('session-1') }).toThrow('another client')
    const observed = control.browserStatus('session-1')
    expect(observed.outcome).toBe('held_elsewhere')
    if (!('claim' in observed)) throw new Error('missing remote claim')
    expect(control.takeoverBrowser('session-1', observed.claim.epoch - 1).outcome).toBe('epoch_stale')
    expect(control.takeoverBrowser('session-1', observed.claim.epoch).outcome).toBe('controlled')
    expect(() => { control.admitBrowserInvoke('session/cancel', args)?.() }).not.toThrow()
    if (!('claim' in remote)) throw new Error('missing remote claim')
    expect(control.release('session-1', remote.claim)).toBe(false)
    expect(() => { control.admitBrowserInvoke('session/rename', args)?.() }).not.toThrow()
  })
  it('requires explicit CAS takeover and fences old writes', () => {
    let now = 1_000
    const control = new DesktopSessionControl(() => now, 5_000)
    const local = { kind: 'local' as const, id: 'window-1' }
    const remote = { kind: 'remote' as const, id: 'web-1' }
    const initial = control.acquire('session-1', local, { takeover: false })
    expect(initial.outcome).toBe('controlled')
    if (!('claim' in initial)) throw new Error('missing initial claim')
    expect(control.acquire('session-1', remote, { takeover: false }).outcome).toBe('held_elsewhere')
    expect(control.acquire('session-1', remote, { takeover: true, expectedEpoch: 0 }).outcome)
      .toBe('epoch_stale')
    const taken = control.acquire('session-1', remote, { takeover: true,
      expectedEpoch: initial.claim.epoch })
    expect(taken.outcome).toBe('controlled')
    if (!('claim' in taken)) throw new Error('missing takeover claim')
    expect(taken.claim.epoch).toBe(initial.claim.epoch + 1)
    expect(() => { control.assertWrite('session-1', initial.claim) }).toThrow('control lost')
    control.assertWrite('session-1', taken.claim)
    expect(control.release('session-1', initial.claim)).toBe(false)
    now += 5_000
    expect(() => { control.assertWrite('session-1', taken.claim) }).toThrow('control lost')
    expect(control.acquire('session-1', local, { takeover: false }).outcome).toBe('controlled')
  })

  it('invalidates old generations and cannot extend another owner', () => {
    let now = 0
    const first = new DesktopSessionControl(() => now, 5_000)
    const owner = { kind: 'remote' as const, id: 'web-1' }
    const state = first.acquire('session-1', owner, { takeover: false })
    if (!('claim' in state)) throw new Error('missing claim')
    now = 1_000
    expect(first.renew('session-1', { ...state.claim, id: 'web-2' }).outcome).toBe('epoch_stale')
    expect(first.renew('session-1', state.claim).outcome).toBe('controlled')
    const restarted = new DesktopSessionControl(() => now, 5_000)
    restarted.acquire('session-1', owner, { takeover: false })
    expect(() => { restarted.assertWrite('session-1', state.claim) }).toThrow('control lost')
  })

  it('bounds expired claims without ever reusing an old proof', () => {
    let now = 0
    const control = new DesktopSessionControl(() => now, 5_000, 2)
    const owner = { kind: 'remote' as const, id: 'web-1' }
    const first = control.acquire('session-1', owner, { takeover: false })
    if (!('claim' in first)) throw new Error('missing first claim')
    control.acquire('session-2', owner, { takeover: false })
    expect(() => control.acquire('session-3', owner, { takeover: false }))
      .toThrow(DesktopSessionControlBusyError)
    now += 5_000
    const replacement = control.acquire('session-1', owner, { takeover: false })
    if (!('claim' in replacement)) throw new Error('missing replacement claim')
    expect(replacement.claim.epoch).toBeGreaterThan(first.claim.epoch)
    expect(() => { control.assertWrite('session-1', first.claim) }).toThrow('control lost')
    expect(control.renew('session-1', first.claim).outcome).toBe('epoch_stale')
  })
})
