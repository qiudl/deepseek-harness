import { describe, expect, it } from 'vitest'
import { DesktopSessionControl } from '../src/desktop-session-control.ts'

describe('Desktop Session control authority', () => {
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
})
