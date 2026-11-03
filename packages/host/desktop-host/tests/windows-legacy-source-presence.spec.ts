import { expect, it, vi } from 'vitest'
import { probeWindowsLegacySourcePresence } from '../src/windows-legacy-source-presence.ts'
import { WindowsHostRegistrationNativeError } from '../src/windows-host-registration-native.ts'
import type { WindowsHostPrivatePathEvidence } from '../src/windows-host-registration.ts'

const userProfile = String.raw`C:\Users\alice`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const root = `${userProfile}\\.dsh`
const evidence: WindowsHostPrivatePathEvidence = {
  kind: 'directory', reparsePoint: false, linkCount: 1, ownerSid: userSid,
  daclProtected: false, access: [],
}

it('reports an existing legacy home without reading contents or admitting migration', () => {
  const inspectExistingDirectory = vi.fn(() => evidence)
  expect(probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: { inspectExistingDirectory } }))
    .toEqual({ observedState: 'present', migrationAdmitted: false })
  expect(inspectExistingDirectory.mock.calls).toHaveLength(4)
})

it('distinguishes missing leaf from missing ancestors and access failures', () => {
  for (const path of ['C:\\', 'C:\\Users', userProfile, root]) {
    for (const code of [2, 3, 5, 32]) {
      const inspectExistingDirectory = vi.fn((value: string) => {
        if (value === path) throw new WindowsHostRegistrationNativeError('CreateFileW', code)
        return evidence
      })
      const result = probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: { inspectExistingDirectory } })
      expect(result.observedState).toBe(path === root && code === 2 ? 'absent' : 'unknown')
      expect(result.migrationAdmitted).toBe(false)
    }
  }
})

it('does not treat redirection, foreign ownership, or arbitrary error objects as absence', () => {
  for (const value of [{ ...evidence, reparsePoint: true }, { ...evidence, kind: 'file' as const },
    { ...evidence, ownerSid: 'S-1-5-21-1000-2000-3000-2002' }]) {
    expect(probeWindowsLegacySourcePresence({ userProfile, userSid,
      bindings: { inspectExistingDirectory: () => value } }).observedState).toBe('unknown')
  }
  for (const error of [new Error('private path'), { api: 'CreateFileW', win32Code: 2 },
    new WindowsHostRegistrationNativeError('GetSecurityInfo', 2)]) {
    expect(probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: {
      inspectExistingDirectory: (path) => { if (path === root) throw error; return evidence },
    } })).toEqual({ observedState: 'unknown', migrationAdmitted: false })
  }
  expect(probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: {
    inspectExistingDirectory: path => path === root ? { ...evidence, reparsePoint: true } : evidence,
  } })).toEqual({ observedState: 'unknown', migrationAdmitted: false })
})

it('accepts the stock-Windows SYSTEM or Administrators owned home while refusing foreign users', () => {
  for (const ownerSid of ['S-1-5-18', 'S-1-5-32-544']) {
    const home = { ...evidence, ownerSid }
    expect(probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: {
      inspectExistingDirectory: (path) => {
        if (path === userProfile || path === root) return home
        return { ...evidence, ownerSid: 'S-1-5-18' }
      },
    } }).observedState).toBe('present')
  }
  for (const ownerSid of ['S-1-5-21-1000-2000-3000-2002', 'S-1-5-21-1000-2000-3000-3003']) {
    expect(probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: {
      inspectExistingDirectory: path => path === userProfile ? { ...evidence, ownerSid } : evidence,
    } }).observedState).toBe('unknown')
    expect(probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: {
      inspectExistingDirectory: path => path === root ? { ...evidence, ownerSid } : evidence,
    } }).observedState).toBe('unknown')
  }
})

it('rejects noncanonical roots and missing bindings before native inspection', () => {
  const inspectExistingDirectory = vi.fn(() => evidence)
  for (const path of ['relative', 'C:\\Users\\..\\alice', '\\\\server\\share', 'C:\\Users\\alice.',
    'C:\\Users\\alice:ads', 'C:\\Users\\alice\\', 'C:\\Users\\CON']) {
    expect(probeWindowsLegacySourcePresence({ userProfile: path, userSid,
      bindings: { inspectExistingDirectory } }).observedState).toBe('unknown')
  }
  expect(inspectExistingDirectory).not.toHaveBeenCalled()
  expect(probeWindowsLegacySourcePresence({ userProfile, userSid, bindings: {} }).observedState).toBe('unknown')
})
