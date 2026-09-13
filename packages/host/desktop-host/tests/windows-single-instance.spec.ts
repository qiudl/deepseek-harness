import { describe, expect, it, vi } from 'vitest'
import {
  WindowsHostPrivateLeaseConflictError,
  type WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'
import { acquireWindowsSingleHostLock } from '../src/windows-single-instance.ts'

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
})
