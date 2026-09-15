import { describe, expect, it, vi } from 'vitest'
import type { WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'
import { createWindowsProfileRegistryFileAuthority } from '../src/windows-profile-registry-files.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\registry`
const path = `${root}\\profiles.json`
const userSid = 'S-1-5-21-1000-2000-3000-1001'

function fixture(existing?: Buffer) {
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
  const ensurePrivateDirectory = vi.fn<WindowsHostRegistrationFileBindings['ensurePrivateDirectory']>(
    () => ({ ...evidence, kind: 'directory' }),
  )
  const readPrivateFile = vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>(
    () => existing === undefined ? undefined : { contents: existing, evidence },
  )
  const replacePrivateFile = vi.fn<WindowsHostRegistrationFileBindings['replacePrivateFile']>(() => evidence)
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory,
    readPrivateFile,
    replacePrivateFile,
    acquirePrivateFileLease: vi.fn(() => ({ evidence, initialize: vi.fn(), release: vi.fn() })),
  }
  const authority = createWindowsProfileRegistryFileAuthority({
    root,
    userSid,
    maximumSnapshotBytes: 1024,
    bindings,
  })
  return { authority, bindings, ensurePrivateDirectory, readPrivateFile, replacePrivateFile, evidence }
}

describe('Windows Profile registry file authority', () => {
  it('loads and persists registry JSON only through stable private file operations', () => {
    const snapshot = { version: 3, profiles: [] }
    const state = fixture(Buffer.from(`${JSON.stringify(snapshot)}\n`))
    state.authority.prepareRoot(root)
    expect(state.authority.loadSnapshot(path)).toEqual(snapshot)
    state.authority.persistSnapshot(path, root, snapshot)
    expect(state.ensurePrivateDirectory).toHaveBeenCalledTimes(2)
    expect(state.readPrivateFile).toHaveBeenCalledWith(path, 1024)
    expect(state.replacePrivateFile).toHaveBeenCalledWith(
      path,
      Buffer.from(`${JSON.stringify(snapshot)}\n`),
      expect.stringContaining('(A;OICI;FA;;;'),
    )
  })

  it('returns undefined for an absent registry and rejects unsafe or oversized snapshots', () => {
    expect(fixture().authority.loadSnapshot(path)).toBeUndefined()
    const unsafe = fixture(Buffer.from('{"version":3,"profiles":[]}'))
    unsafe.readPrivateFile.mockReturnValueOnce({
      contents: Buffer.from('{"version":3,"profiles":[]}'),
      evidence: { ...unsafe.evidence, reparsePoint: true },
    })
    expect(() => { unsafe.authority.loadSnapshot(path) }).toThrow()
    expect(() => { unsafe.authority.persistSnapshot(path, root, { value: 'x'.repeat(2048) }) }).toThrow()
  })

  it('rejects invalid limits, paths, JSON and replacement evidence', () => {
    for (const maximumSnapshotBytes of [0, Number.POSITIVE_INFINITY]) {
      expect(() => createWindowsProfileRegistryFileAuthority({
        root, userSid, maximumSnapshotBytes, bindings: fixture().bindings,
      })).toThrow('invalid_input')
    }

    const malformed = fixture(Buffer.from('{'))
    expect(() => { malformed.authority.prepareRoot(`${root}\\other`) }).toThrow('invalid_input')
    expect(() => malformed.authority.loadSnapshot(`${path}.other`)).toThrow('invalid_input')
    expect(() => malformed.authority.loadSnapshot(path)).toThrow('unavailable')
    expect(() => { malformed.authority.persistSnapshot(`${path}.other`, root, {}) }).toThrow('invalid_input')
    expect(() => { malformed.authority.persistSnapshot(path, `${root}\\other`, {}) }).toThrow('invalid_input')

    const unsafe = fixture()
    unsafe.replacePrivateFile.mockReturnValueOnce({ ...unsafe.evidence, reparsePoint: true })
    expect(() => { unsafe.authority.persistSnapshot(path, root, {}) }).toThrow()
  })
})
