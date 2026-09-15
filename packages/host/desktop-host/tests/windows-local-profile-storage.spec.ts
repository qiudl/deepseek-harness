import { describe, expect, it, vi } from 'vitest'
import { createWindowsLocalProfileStorage } from '../src/windows-local-profile-storage.ts'
import { loadWindowsLocalProfileStorage, loadWindowsLegacySourceProbe } from '../src/windows-local-profile-storage-native.ts'
import type { WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\environments\staging\authority`
const userSid = 'S-1-5-21-1000-2000-3000-1001'

function fixture() {
  const evidence = {
    kind: 'file' as const, reparsePoint: false, linkCount: 1, ownerSid: userSid, daclProtected: true,
    access: [userSid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({
      sid, type: 'allow' as const, mask: 0x1F01FF,
      inherited: false, objectInherit: true, containerInherit: true,
    })),
  }
  let disk: Buffer | undefined
  const release = vi.fn()
  const bindings = {
    ensurePrivateDirectory: vi.fn<WindowsHostRegistrationFileBindings['ensurePrivateDirectory']>(
      () => ({ ...evidence, kind: 'directory' }),
    ),
    readPrivateFile: vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>(
      () => disk === undefined ? undefined : { contents: disk, evidence },
    ),
    replacePrivateFile: vi.fn<WindowsHostRegistrationFileBindings['replacePrivateFile']>(
      (_path, contents) => { disk = Buffer.from(contents); return evidence },
    ),
    acquirePrivateFileLease: vi.fn(() => ({ evidence, initialize: vi.fn(), release })),
  } satisfies WindowsHostRegistrationFileBindings
  const store = createWindowsLocalProfileStorage({ root, userSid, bindings })
  return { store, bindings, evidence, release }
}

describe('Windows Main local Profile ciphertext storage', () => {
  it('rejects non-canonical or control-bearing authority roots before native access', () => {
    const state = fixture()
    for (const unsafeRoot of [
      String.raw`authority`,
      'C:\\authority\u0000',
      String.raw`C:\authority:alternate`,
      String.raw`C:\authority\..\other`,
    ]) {
      expect(() => createWindowsLocalProfileStorage({
        root: unsafeRoot, userSid, bindings: state.bindings,
      })).toThrow('invalid_input')
    }
    expect(state.bindings.ensurePrivateDirectory).not.toHaveBeenCalled()
  })

  it('loads the legacy probe without touching a source and exposes no writer', async () => {
    const state = fixture()
    const inspectExistingDirectory = vi.fn(() => ({ ...state.evidence, kind: 'directory' as const }))
    const probe = await loadWindowsLegacySourceProbe({
      userProfile: String.raw`C:\Users\alice`, platform: 'win32', arch: 'x64',
    }, {
      loadCurrentUserSid: async () => () => userSid,
      loadRegistrationFileBindings: async () => ({ ...state.bindings, inspectExistingDirectory }),
    })
    expect(inspectExistingDirectory).not.toHaveBeenCalled()
    expect(probe()).toEqual({ observedState: 'present', migrationAdmitted: false })
    expect(state.bindings.ensurePrivateDirectory).not.toHaveBeenCalled()
    expect(state.bindings.readPrivateFile).not.toHaveBeenCalled()
    expect(state.bindings.replacePrivateFile).not.toHaveBeenCalled()
    expect(state.bindings.acquirePrivateFileLease).not.toHaveBeenCalled()
  })

  it('rejects unsupported native loading and SID failures before inspecting legacy data', async () => {
    const loadCurrentUserSid = vi.fn(async () => { throw new Error('sid unavailable') })
    const loadRegistrationFileBindings = vi.fn(async () => fixture().bindings)
    await expect(loadWindowsLegacySourceProbe({ userProfile: root, platform: 'darwin', arch: 'arm64' },
      { loadCurrentUserSid, loadRegistrationFileBindings })).rejects.toThrow('Windows x64')
    expect(loadCurrentUserSid).not.toHaveBeenCalled()
    await expect(loadWindowsLegacySourceProbe({ userProfile: root, platform: 'win32', arch: 'x64' },
      { loadCurrentUserSid, loadRegistrationFileBindings })).rejects.toThrow('sid unavailable')
    expect(loadRegistrationFileBindings).not.toHaveBeenCalled()
    await expect(loadWindowsLegacySourceProbe({ userProfile: root, platform: 'win32', arch: 'x64' }, {
      loadCurrentUserSid: async () => () => userSid,
      loadRegistrationFileBindings,
    })).rejects.toThrow('directory inspector is unavailable')
    await expect(loadWindowsLegacySourceProbe({ userProfile: root, platform: 'win32', arch: 'x64' }))
      .rejects.toThrow('release pin is invalid')
  })
  it('requires an explicit native release pin instead of searching for a Koffi installation', async () => {
    await expect(loadWindowsLocalProfileStorage({ root, platform: 'win32', arch: 'x64' }))
      .rejects.toThrow('Windows vault native module release pin is invalid')
  })

  it('composes native process identity and file bindings without reading or writing the vault', async () => {
    const state = fixture()
    const querySid = vi.fn(() => userSid)
    const store = await loadWindowsLocalProfileStorage({ root, platform: 'win32', arch: 'x64' }, {
      loadCurrentUserSid: async () => querySid,
      loadRegistrationFileBindings: async () => state.bindings,
    })
    expect(querySid).toHaveBeenCalledTimes(1)
    expect(state.bindings.readPrivateFile).not.toHaveBeenCalled()
    expect(state.bindings.ensurePrivateDirectory).not.toHaveBeenCalled()
    store.withWriterLock(() => { store.replace(Buffer.from('sealed')) })
    expect(store.read()).toEqual(Buffer.from('sealed'))
  })

  it('rejects unsupported platforms before loading any native library', async () => {
    const loadCurrentUserSid = vi.fn(async () => () => userSid)
    for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'arm64']] as const) {
      await expect(loadWindowsLocalProfileStorage({ root, platform, arch }, { loadCurrentUserSid })).rejects.toThrow()
    }
    expect(loadCurrentUserSid).not.toHaveBeenCalled()
  })

  it('uses process platform defaults without bypassing Windows x64 or native binding gates', async () => {
    const state = fixture()
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    try {
      await expect(loadWindowsLocalProfileStorage({ root }, {
        loadCurrentUserSid: async () => () => userSid,
        loadRegistrationFileBindings: async () => state.bindings,
      })).resolves.toBeDefined()
    } finally {
      platform.mockRestore()
      arch.mockRestore()
    }
    await expect(loadWindowsLocalProfileStorage({ root })).rejects.toThrow('Windows x64')
    const defaultRuntimeGate = process.platform === 'win32' && process.arch === 'x64'
      ? 'release pin is invalid'
      : 'Windows x64'
    await expect(loadWindowsLocalProfileStorage({ root, platform: 'win32' })).rejects.toThrow(defaultRuntimeGate)
    await expect(loadWindowsLocalProfileStorage({ root, platform: 'win32', arch: 'x64' }, {
      loadCurrentUserSid: async () => () => userSid,
    })).rejects.toThrow('release pin is invalid')
  })

  it('does not expose a partial store when native identity or file loading fails', async () => {
    const state = fixture()
    for (const identityFails of [true, false]) {
      await expect(loadWindowsLocalProfileStorage({ root, platform: 'win32', arch: 'x64' }, {
        loadCurrentUserSid: async () => () => {
          if (identityFails) throw new Error('token unavailable')
          return userSid
        },
        loadRegistrationFileBindings: async () => {
          if (!identityFails) throw new Error('bindings unavailable')
          return state.bindings
        },
      })).rejects.toThrow()
    }
    expect(state.bindings.ensurePrivateDirectory).not.toHaveBeenCalled()
    expect(state.bindings.readPrivateFile).not.toHaveBeenCalled()
  })

  it('reads absent state without writes and persists only under a verified native lease', () => {
    const state = fixture()
    expect(state.store.read()).toBeNull()
    expect(state.bindings.ensurePrivateDirectory).not.toHaveBeenCalled()
    expect(() =>{  state.store.replace(Buffer.from('sealed')) }).toThrow()
    state.store.withWriterLock(() =>{  state.store.replace(Buffer.from('sealed')) })
    expect(state.store.read()).toEqual(Buffer.from('sealed'))
    expect(state.bindings.replacePrivateFile).toHaveBeenCalledWith(
      `${root}\\local-profile.v1.json`, Buffer.from('sealed'), expect.stringContaining(userSid),
    )
    expect(state.release).toHaveBeenCalledTimes(1)
  })

  it('releases a rejected lease before running any callback', () => {
    const state = fixture()
    const callback = vi.fn<() => void>()
    state.evidence.reparsePoint = true
    // Directory evidence is independent of the rejected lock-file evidence.
    vi.mocked(state.bindings.ensurePrivateDirectory).mockReturnValue({
      ...state.evidence, kind: 'directory', reparsePoint: false,
    })
    expect(() =>{  state.store.withWriterLock(callback) }).toThrow()
    expect(callback).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledTimes(1)
  })

  it('releases on callback failure and rejects nested writers', () => {
    const state = fixture()
    expect(() =>{  state.store.withWriterLock(() => {
      state.store.withWriterLock(() => undefined)
    }) }).toThrow()
    expect(state.release).toHaveBeenCalledTimes(1)
    state.store.withWriterLock(() =>{  state.store.replace(Buffer.from('next')) })
    expect(state.release).toHaveBeenCalledTimes(2)
  })

  it('does not reinterpret native read failures or unsafe evidence as an empty vault', () => {
    const state = fixture()
    vi.mocked(state.bindings.readPrivateFile).mockImplementationOnce(() => { throw new Error('access denied') })
    expect(() => state.store.read()).toThrow('access denied')
    vi.mocked(state.bindings.readPrivateFile).mockReturnValue({
      contents: Buffer.from('sealed'), evidence: { ...state.evidence, ownerSid: 'S-1-5-18' },
    })
    expect(() => state.store.read()).toThrow()
    expect(state.bindings.replacePrivateFile).not.toHaveBeenCalled()
  })

  it('bounds both native reads and replacements to the envelope limit', () => {
    const state = fixture()
    vi.mocked(state.bindings.readPrivateFile).mockReturnValue({
      contents: Buffer.alloc(16385), evidence: state.evidence,
    })
    expect(() => state.store.read()).toThrow()
    expect(state.bindings.readPrivateFile).toHaveBeenCalledWith(`${root}\\local-profile.v1.json`, 16384)
    expect(() => {
      state.store.withWriterLock(() => {
        state.store.replace(Buffer.alloc(16385))
      })
    }).toThrow()
    expect(state.bindings.replacePrivateFile).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledTimes(1)
  })
})
