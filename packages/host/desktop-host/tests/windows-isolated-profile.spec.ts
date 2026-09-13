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
      pluginRoots: [`${root}\\profiles\\${profileId}\\plugins`],
      persistenceGeneration: 1,
    })
    expect(state.ensurePrivateDirectory.mock.calls.map(call => call[0])).toEqual([
      root,
      `${root}\\profiles`,
      `${root}\\profiles\\${profileId}`,
      `${root}\\profiles\\${profileId}\\persistence`,
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
})
