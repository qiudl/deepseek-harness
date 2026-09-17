import { describe, expect, it, vi } from 'vitest'
import type {
  WindowsHostPrivatePathEvidence,
  WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'
import { prepareWindowsIsolatedProfile } from '../src/windows-isolated-profile.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH`
const profileId = '11111111-1111-4111-8111-111111111111'
const userSid = 'S-1-5-21-1000-2000-3000-1001'

function evidence(kind: 'directory' | 'file'): WindowsHostPrivatePathEvidence {
  return {
    kind,
    reparsePoint: false,
    linkCount: 1,
    ownerSid: userSid,
    daclProtected: true,
    access: [
      { sid: userSid, type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-18', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-32-544', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
    ],
  }
}

function fixture(existing = new Map<string, Buffer>()) {
  const ensurePrivateDirectory = vi.fn<WindowsHostRegistrationFileBindings['ensurePrivateDirectory']>(
    () => evidence('directory'),
  )
  const readPrivateFile = vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((path) => {
    const contents = existing.get(path)
    return contents === undefined ? undefined : { contents, evidence: evidence('file') }
  })
  const createPrivateFile = vi.fn<NonNullable<WindowsHostRegistrationFileBindings['createPrivateFile']>>(
    (path, contents) => {
      if (existing.has(path)) return { state: 'exists', evidence: evidence('file') }
      existing.set(path, Buffer.from(contents))
      return { state: 'created', evidence: evidence('file') }
    },
  )
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory,
    readPrivateFile,
    createPrivateFile,
    replacePrivateFile: vi.fn(() => evidence('file')),
    acquirePrivateFileLease: vi.fn(() => ({
      evidence: evidence('file'), initialize: vi.fn(), release: vi.fn(),
    })),
  }
  return { bindings, existing, ensurePrivateDirectory, readPrivateFile, createPrivateFile }
}

describe('Windows isolated Profile preparation', () => {
  /** The shape a Profile writer leaves behind: inherited ACEs under an administrator owner. */
  function rewrittenEvidence(): WindowsHostPrivatePathEvidence {
    return {
      kind: 'file',
      reparsePoint: false,
      linkCount: 1,
      ownerSid: 'S-1-5-32-544',
      daclProtected: false,
      access: [
        { sid: userSid, type: 'allow', mask: 0x1F01FF, inherited: true, objectInherit: false, containerInherit: false },
        { sid: 'S-1-5-18', type: 'allow', mask: 0x1F01FF, inherited: true, objectInherit: false, containerInherit: false },
        { sid: 'S-1-5-32-544', type: 'allow', mask: 0x1F01FF, inherited: true, objectInherit: false, containerInherit: false },
      ],
    }
  }

  it('republishes a managed file the Profile rewrote, preserving its contents', () => {
    const credentials = `${root}\\profiles\\${profileId}\\owner-state\\.credentials.yaml`
    const saved = Buffer.from('{"version":1,"refs":{"deepseek":"k"},"records":{}}\n')
    const existing = new Map<string, Buffer>([[credentials, saved]])
    const state = fixture(existing)
    const rewritten = rewrittenEvidence()
    state.readPrivateFile.mockImplementation((path) => {
      const contents = existing.get(path)
      if (contents === undefined) return undefined
      return { contents, evidence: path === credentials ? rewritten : evidence('file') }
    })
    state.createPrivateFile.mockImplementation((path, contents) => {
      if (existing.has(path)) {
        return { state: 'exists', evidence: path === credentials ? rewritten : evidence('file') }
      }
      existing.set(path, Buffer.from(contents))
      return { state: 'created', evidence: evidence('file') }
    })

    expect(() => prepareWindowsIsolatedProfile({
      root, profileId, userSid, maximumManagedFileBytes: 64 * 1024, bindings: state.bindings,
    })).not.toThrow()

    const replace = state.bindings.replacePrivateFile as ReturnType<typeof vi.fn>
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace.mock.calls[0]?.[0]).toBe(credentials)
    expect(replace.mock.calls[0]?.[1]).toEqual(saved)
  })

  it('leaves an already private managed file untouched', () => {
    const credentials = `${root}\\profiles\\${profileId}\\owner-state\\.credentials.yaml`
    const state = fixture(new Map([[credentials, Buffer.from('{"version":1,"refs":{},"records":{}}\n')]]))

    prepareWindowsIsolatedProfile({
      root, profileId, userSid, maximumManagedFileBytes: 64 * 1024, bindings: state.bindings,
    })

    expect(state.bindings.replacePrivateFile).not.toHaveBeenCalled()
  })

  it('rejects non-canonical or control-bearing roots before native access', () => {
    const state = fixture()
    for (const unsafeRoot of [
      'relative',
      'C:\\unsafe\u0000',
      String.raw`C:\unsafe:alternate`,
      String.raw`C:\unsafe\..\other`,
    ]) {
      expect(() => prepareWindowsIsolatedProfile({
        root: unsafeRoot, profileId, userSid, maximumManagedFileBytes: 64 * 1024,
        bindings: state.bindings,
      })).toThrow('invalid_input')
    }
    expect(state.ensurePrivateDirectory).not.toHaveBeenCalled()
  })

  it('prepares private MCP directories and preserves a large customized patch on restart', () => {
    const state = fixture()
    const options = { root, profileId, userSid, maximumManagedFileBytes: 64 * 1024,
      prepareMcpStorage: true, bindings: state.bindings }
    prepareWindowsIsolatedProfile(options)
    const web = `${root}\\profiles\\${profileId}\\profiles\\web`
    expect(state.ensurePrivateDirectory.mock.calls.map(([path]) => path)).toContain(web)
    expect(state.existing.get(`${web}\\cordis.patch.yml`)?.toString()).toBe('[]\n')
    const custom = Buffer.from(`#${'x'.repeat(70_000)}\n[]\n`)
    state.existing.set(`${web}\\cordis.patch.yml`, custom)
    prepareWindowsIsolatedProfile(options)
    expect(state.existing.get(`${web}\\cordis.patch.yml`)).toEqual(custom)
    expect(state.readPrivateFile).toHaveBeenCalledWith(`${web}\\cordis.patch.yml`, 1_048_576)
    state.existing.set(`${web}\\cordis.patch.yml`, Buffer.alloc(1_048_577))
    expect(() => { prepareWindowsIsolatedProfile(options) }).toThrow()
  })
  it('rejects unsafe existing web directories without creating or replacing their patch', () => {
    const state = fixture()
    const web = `${root}\\profiles\\${profileId}\\profiles\\web`
    state.ensurePrivateDirectory.mockImplementation(path => path === web
      ? { ...evidence('directory'), daclProtected: false } : evidence('directory'))
    expect(() => { prepareWindowsIsolatedProfile({ root, profileId, userSid,
      maximumManagedFileBytes: 64 * 1024, prepareMcpStorage: true, bindings: state.bindings }) }).toThrow()
    expect(state.createPrivateFile).not.toHaveBeenCalled()
  })
  it('creates a complete local-only Profile without touching a legacy source', () => {
    const state = fixture()
    const result = prepareWindowsIsolatedProfile({
      root, profileId, userSid, maximumManagedFileBytes: 64 * 1024, bindings: state.bindings,
    })

    expect(result).toEqual({
      profileRoot: `${root}\\profiles\\${profileId}`,
      persistenceRoot: `${root}\\profiles\\${profileId}\\persistence`,
      tempRoot: `${root}\\profiles\\${profileId}\\temp`,
      pluginRoots: [`${root}\\profiles\\${profileId}\\plugins`],
      persistenceGeneration: 1,
    })
    expect(state.ensurePrivateDirectory.mock.calls.map(call => call[0])).toEqual([
      root,
      `${root}\\profiles`,
      `${root}\\profiles\\${profileId}`,
      `${root}\\profiles\\${profileId}\\persistence`,
      `${root}\\profiles\\${profileId}\\temp`,
      `${root}\\profiles\\${profileId}\\plugins`,
      `${root}\\profiles\\${profileId}\\owner-state`,
      `${root}\\profiles\\${profileId}\\owner-state\\storages`,
    ])
    expect([...state.existing.keys()]).toEqual([
      `${root}\\profiles\\${profileId}\\owner-state\\settings.yaml`,
      `${root}\\profiles\\${profileId}\\owner-state\\.credentials.yaml`,
      `${root}\\profiles\\${profileId}\\owner-state\\profile.json`,
      `${root}\\profiles\\${profileId}\\owner-state\\storages\\workspace.json`,
      `${root}\\profiles\\${profileId}\\cordis.patch.yml`,
    ])
    expect([...state.existing.keys()].some(path => path.includes(String.raw`C:\Users\alice\.dsh`))).toBe(false)
  })

  it('preserves mutable Profile documents and verifies an existing Host-owned patch', () => {
    const state = fixture()
    const options = {
      root, profileId, userSid, maximumManagedFileBytes: 64 * 1024, bindings: state.bindings,
    }
    prepareWindowsIsolatedProfile(options)
    const settingsPath = `${root}\\profiles\\${profileId}\\owner-state\\settings.yaml`
    const customized = Buffer.from('permission:\n  defaultPreset: read-only\n')
    state.existing.set(settingsPath, customized)

    prepareWindowsIsolatedProfile(options)

    expect(state.existing.get(settingsPath)).toEqual(customized)
    expect(state.createPrivateFile).toHaveBeenCalledTimes(10)
    expect(state.readPrivateFile).toHaveBeenCalledTimes(5)
  })

  it('rejects a changed Host patch and unsafe existing mutable file', () => {
    const changed = fixture()
    const options = {
      root, profileId, userSid, maximumManagedFileBytes: 64 * 1024, bindings: changed.bindings,
    }
    prepareWindowsIsolatedProfile(options)
    changed.existing.set(`${root}\\profiles\\${profileId}\\cordis.patch.yml`, Buffer.from('changed\n'))
    expect(() => { prepareWindowsIsolatedProfile(options) }).toThrow()

    const unsafe = fixture(new Map([
      [`${root}\\profiles\\${profileId}\\owner-state\\settings.yaml`, Buffer.from('{}\n')],
    ]))
    unsafe.readPrivateFile.mockReturnValueOnce({
      contents: Buffer.from('{}\n'), evidence: { ...evidence('file'), reparsePoint: true },
    })
    expect(() => { prepareWindowsIsolatedProfile({ ...options, bindings: unsafe.bindings }) }).toThrow()
  })

  it('fails closed when create-only native support is unavailable', () => {
    const state = fixture()
    const bindings = { ...state.bindings }
    delete bindings.createPrivateFile
    expect(() => { prepareWindowsIsolatedProfile({
      root, profileId, userSid, maximumManagedFileBytes: 64 * 1024, bindings,
    }) }).toThrow()
  })

  it('rejects managed files beyond the limit and vanished create-only conflicts', () => {
    const bounded = fixture()
    expect(() => prepareWindowsIsolatedProfile({
      root, profileId, userSid, maximumManagedFileBytes: 1, bindings: bounded.bindings,
    })).toThrow('unavailable')
    expect(bounded.createPrivateFile).not.toHaveBeenCalled()

    const vanished = fixture()
    vanished.createPrivateFile.mockReturnValue({ state: 'exists', evidence: evidence('file') })
    expect(() => prepareWindowsIsolatedProfile({
      root, profileId, userSid, maximumManagedFileBytes: 64 * 1024, bindings: vanished.bindings,
    })).toThrow('unavailable')
    expect(vanished.readPrivateFile).toHaveBeenCalledOnce()
  })
})
