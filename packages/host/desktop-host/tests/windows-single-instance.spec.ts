import { describe, expect, it, vi } from 'vitest'
import {
  WindowsHostPrivateLeaseConflictError,
  type WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'
import { acquireWindowsSingleHostLock, WindowsSingleHostLock } from '../src/windows-single-instance.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host`
const userSid = 'S-1-5-21-1000-2000-3000-1001'

function fixture() {
  const release = vi.fn()
  const initialize = vi.fn()
  const evidence = {
    kind: 'file' as const,
    reparsePoint: false,
    linkCount: 1,
    ownerSid: userSid,
    daclProtected: true,
    access: [
      { sid: userSid, type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-18', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-32-544', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
    ],
  }
  const acquirePrivateFileLease = vi.fn<WindowsHostRegistrationFileBindings['acquirePrivateFileLease']>(
    () => ({ evidence, initialize, release }),
  )
  const ensurePrivateDirectory = vi.fn<WindowsHostRegistrationFileBindings['ensurePrivateDirectory']>(
    () => ({ ...evidence, kind: 'directory' }),
  )
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory,
    readPrivateFile: vi.fn(() => undefined),
    replacePrivateFile: vi.fn(() => evidence),
    acquirePrivateFileLease,
  }
  return { bindings, ensurePrivateDirectory, acquirePrivateFileLease, initialize, release, evidence }
}

describe('Windows single Host lock', () => {
  it('rejects malformed identity and path inputs before native access', () => {
    const state = fixture()
    const valid = {
      root,
      userSid,
      pid: 42,
      processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
      bindings: state.bindings,
    }
    for (const override of [
      { root: 'relative' },
      { root: 'C:\\unsafe\u0000' },
      { root: String.raw`C:\unsafe:alternate` },
      { root: String.raw`C:\unsafe\..\other` },
      { pid: Number.NaN },
      { pid: 0 },
      { processNonce: 'short' },
      { processNonce: 'a'.repeat(257) },
      { processNonce: '0123456789abcdef\u0000' },
    ]) {
      expect(() => acquireWindowsSingleHostLock({ ...valid, ...override })).toThrow('invalid_input')
    }
    expect(state.ensurePrivateDirectory).not.toHaveBeenCalled()
    expect(() => new WindowsSingleHostLock({
      evidence: state.evidence, initialize: state.initialize, release: state.release,
    }, Symbol('foreign'))).toThrow('unauthorized')
  })

  it('holds one kernel file lease and releases it exactly once without deleting data', () => {
    const state = fixture()
    const lock = acquireWindowsSingleHostLock({
      root,
      userSid,
      pid: 42,
      processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
      bindings: state.bindings,
    })
    expect(state.ensurePrivateDirectory).toHaveBeenCalledOnce()
    expect(state.acquirePrivateFileLease).toHaveBeenCalledWith(
      String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host\host.lock`,
      expect.stringContaining(userSid),
    )
    expect(state.initialize).toHaveBeenCalledWith(expect.any(Buffer))
    lock.assertOwner()
    lock.release()
    lock.release()
    expect(state.release).toHaveBeenCalledOnce()
    expect(() => { lock.assertOwner() }).toThrow()
  })

  it('maps a native sharing conflict to the closed Host conflict code', () => {
    const state = fixture()
    state.acquirePrivateFileLease.mockImplementationOnce(() => { throw new WindowsHostPrivateLeaseConflictError() })
    expect(() => acquireWindowsSingleHostLock({
      root,
      userSid,
      pid: 42,
      processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
      bindings: state.bindings,
    })).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it('releases an acquired native handle when its evidence is unsafe', () => {
    const state = fixture()
    state.acquirePrivateFileLease.mockReturnValueOnce({
      evidence: { ...state.evidence, reparsePoint: true },
      initialize: state.initialize,
      release: state.release,
    })
    expect(() => acquireWindowsSingleHostLock({
      root,
      userSid,
      pid: 42,
      processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
      bindings: state.bindings,
    })).toThrow()
    expect(state.release).toHaveBeenCalledOnce()
  })

  it('preserves initialization and evidence failures even when cleanup also fails', () => {
    for (const failure of ['evidence', 'initialize'] as const) {
      const state = fixture()
      state.release.mockImplementation(() => { throw new Error('cleanup failed') })
      if (failure === 'evidence') {
        state.acquirePrivateFileLease.mockReturnValue({
          evidence: { ...state.evidence, reparsePoint: true },
          initialize: state.initialize,
          release: state.release,
        })
      } else state.initialize.mockImplementation(() => { throw new Error('initialize failed') })
      expect(() => acquireWindowsSingleHostLock({
        root,
        userSid,
        pid: 42,
        processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
        bindings: state.bindings,
      })).toThrow('unavailable')
      expect(state.release).toHaveBeenCalledOnce()
    }
  })

  it('maps unexpected native acquisition failures to unavailable', () => {
    const state = fixture()
    state.ensurePrivateDirectory.mockImplementation(() => { throw new Error('native failure') })
    expect(() => acquireWindowsSingleHostLock({
      root,
      userSid,
      pid: 42,
      processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
      bindings: state.bindings,
    })).toThrow(expect.objectContaining({ code: 'unavailable' }))
  })
})
