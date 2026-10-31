import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyClaimRecoveryStore } from '../src/legacy-claim-recovery.ts'
import { FileLegacyClaimRecoveryFiles } from '../src/legacy-claim-recovery-files.ts'
import { LegacyClaimTarget } from '../src/legacy-claim-target.ts'
import { FileLegacyClaimTargetFiles, WindowsLegacyClaimTargetFiles } from '../src/legacy-claim-target-files.ts'
import type { AppliedMigrationOwnerState } from '../src/migration-owner-state-applicator.ts'
import type { WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'

const profileId = 'b9e8b0aa-5c8e-4d4c-8e7a-139a86985f41'
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const windowsRoot = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\profiles`
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function unixFixture() {
  const profilesRoot = mkdtempSync(join(tmpdir(), 'dsh-target-files-'))
  dirs.push(profilesRoot)
  const profileRoot = join(profilesRoot, profileId)
  const parent = join(profileRoot, 'migration-owner-state')
  const root = join(parent, '1')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(profileRoot, 0o700)
  chmodSync(parent, 0o700)
  const paths: AppliedMigrationOwnerState = {
    generation: 1, settingsPath: join(root, 'settings.yaml'),
    credentialsPath: join(root, '.credentials.yaml'), storageRoot: join(root, 'storages'),
  }
  writeFileSync(paths.settingsPath, '{}\n', { mode: 0o600 })
  writeFileSync(paths.credentialsPath, '{"version":1,"refs":{},"records":{}}\n', { mode: 0o600 })
  const uid = process.getuid?.()
  if (uid === undefined) throw Error('unix_uid_required')
  return { paths, uid, root, profileRoot, parent }
}

function evidence(kind: 'directory' | 'file'): WindowsHostPrivatePathEvidence {
  return {
    kind, reparsePoint: false, linkCount: 1, ownerSid: userSid, daclProtected: true,
    access: [
      { sid: userSid, type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-18', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-32-544', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
    ],
  }
}

function windowsFixture() {
  const root = win32.join(windowsRoot, profileId, 'owner-state')
  const values = new Map<string, Buffer>([
    [win32.join(root, 'settings.yaml'), Buffer.from('{}\n')],
    [win32.join(root, '.credentials.yaml'), Buffer.from('{"version":1,"refs":{},"records":{}}\n')],
  ])
  const bindings: WindowsHostRegistrationFileBindings = {
    inspectExistingDirectory: vi.fn(() => evidence('directory')),
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn((path: string) => {
      const contents = values.get(path)
      return contents === undefined ? undefined : { contents, evidence: evidence('file') }
    }),
    replacePrivateFile: vi.fn((path: string, bytes: Buffer) => {
      values.set(path, Buffer.from(bytes)); return evidence('file')
    }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  }
  return { root, values, bindings, options: { profilesRoot: windowsRoot, profileId, userSid,
    maximumBytes: 1024, bindings } }
}

describe('legacy claim live target files', () => {
  it.skipIf(process.platform === 'win32')('reads and durably replaces only the two Unix generation documents', () => {
    const options = unixFixture()
    const files = new FileLegacyClaimTargetFiles(options.paths, options.uid)
    expect(files.read('settings').toString()).toBe('{}\n')
    expect(files.read('credentials').toString()).toContain('refs')
    files.replace('settings', Buffer.from('{"personal":1}\n'))
    files.replace('credentials', Buffer.from('{"version":1,"refs":{"KEY":"secret"},"records":{}}\n'))
    expect(readFileSync(options.paths.settingsPath, 'utf8')).toBe('{"personal":1}\n')
    expect(files.read('credentials').toString()).toContain('secret')
  })

  it.skipIf(process.platform === 'win32')('projects and verifies one provider through real Unix target and recovery files', () => {
    const options = unixFixture()
    const files = new FileLegacyClaimTargetFiles(options.paths, options.uid)
    const recovery = new LegacyClaimRecoveryStore(
      new FileLegacyClaimRecoveryFiles(dirname(options.profileRoot), options.uid),
    )
    const target = new LegacyClaimTarget(files, recovery)
    const prepared = target.prepare({
      profileId, operationId: '97086a03-9508-41c0-bec3-7464dc835953',
      candidateId: 'llm-deepseek:deepseek', targetGeneration: 1,
      sourceSettings: { 'llm-deepseek': { apiKeyEnv: 'OLD_KEY' } },
      sourceCredentials: { refs: { OLD_KEY: 'old-secret' }, records: {} },
      guard: () => undefined,
    })
    target.publish(prepared, () => undefined)
    expect(readFileSync(options.paths.settingsPath)).toEqual(prepared.settingsAfter)
    expect(readFileSync(options.paths.credentialsPath)).toEqual(prepared.credentialsAfter)
    target.restore(prepared.recovery, () => undefined)
    expect(files.read('settings').toString()).toBe('{}\n')
    expect(files.read('credentials').toString()).not.toContain('old-secret')
  })

  it.skipIf(process.platform === 'win32')('rejects malformed Unix paths, unsafe files, and failed publication', () => {
    const options = unixFixture()
    expect(() => new FileLegacyClaimTargetFiles({ ...options.paths, settingsPath: 'relative' }, options.uid)).toThrow()
    expect(() => new FileLegacyClaimTargetFiles({ ...options.paths, generation: 2 }, options.uid)).toThrow()
    expect(() => new FileLegacyClaimTargetFiles(options.paths, -1)).toThrow()
    const files = new FileLegacyClaimTargetFiles(options.paths, options.uid)
    expect(() => { files.replace('settings', Buffer.alloc(0)) }).toThrow()
    expect(() => { files.replace('settings', Buffer.alloc(16 * 1024 * 1024 + 1)) }).toThrow()
    chmodSync(options.paths.settingsPath, 0o644)
    expect(() => files.read('settings')).toThrow()
    chmodSync(options.paths.settingsPath, 0o600)
    rmSync(options.paths.settingsPath)
    const other = join(options.root, 'other')
    writeFileSync(other, '{}\n', { mode: 0o600 })
    linkSync(other, options.paths.settingsPath)
    expect(() => files.read('settings')).toThrow()
    rmSync(options.paths.settingsPath)
    symlinkSync(other, options.paths.settingsPath)
    expect(() => files.read('settings')).toThrow()
    rmSync(options.paths.settingsPath)
    mkdirSync(options.paths.settingsPath)
    expect(() => { files.replace('settings', Buffer.from('{}\n')) }).toThrow()
    rmSync(options.paths.settingsPath, { recursive: true })
    chmodSync(options.parent, 0o777)
    expect(() => files.read('credentials')).toThrow()
  })

  it.skipIf(process.platform === 'win32')('removes the temporary Unix file when publication fails', () => {
    const options = unixFixture()
    const files = new FileLegacyClaimTargetFiles(options.paths, options.uid, () => {
      rmSync(options.paths.settingsPath)
      mkdirSync(options.paths.settingsPath)
    })
    expect(() => { files.replace('settings', Buffer.from('{"new":true}\n')) }).toThrow()
    expect(readdirSync(options.root).sort()).toEqual(['.credentials.yaml', 'settings.yaml'])
  })

  it('reads and replaces Windows SID-private documents through native bindings', () => {
    const state = windowsFixture()
    const files = new WindowsLegacyClaimTargetFiles(state.options)
    expect(files.read('settings').toString()).toBe('{}\n')
    files.replace('credentials', Buffer.from('{"version":1,"refs":{"KEY":"secret"},"records":{}}\n'))
    expect(files.read('credentials').toString()).toContain('secret')
    expect(state.values.size).toBe(2)
  })

  it('rejects Windows path, ancestor, file, and capacity faults', () => {
    const state = windowsFixture()
    expect(() => new WindowsLegacyClaimTargetFiles({ ...state.options, profilesRoot: `${windowsRoot}\\..\\bad` }))
      .toThrow()
    expect(() => new WindowsLegacyClaimTargetFiles({ ...state.options, profileId: '../bad' })).toThrow()
    expect(() => new WindowsLegacyClaimTargetFiles({ ...state.options, maximumBytes: 0 })).toThrow()
    const noInspect = { ...state.bindings }
    delete noInspect.inspectExistingDirectory
    expect(() => new WindowsLegacyClaimTargetFiles({ ...state.options, bindings: noInspect })).toThrow()
    const files = new WindowsLegacyClaimTargetFiles(state.options)
    expect(() => { files.replace('settings', Buffer.alloc(0)) }).toThrow()
    expect(() => { files.replace('settings', Buffer.alloc(1025)) }).toThrow()
    vi.spyOn(state.bindings, 'inspectExistingDirectory').mockReturnValueOnce({
      ...evidence('directory'), daclProtected: false,
    })
    expect(() => files.read('settings')).toThrow()
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce(undefined)
    expect(() => files.read('settings')).toThrow()
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce({
      contents: Buffer.from('{}\n'), evidence: { ...evidence('file'), linkCount: 2 },
    })
    expect(() => files.read('settings')).toThrow()
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce({
      contents: Buffer.alloc(1025), evidence: evidence('file'),
    })
    expect(() => files.read('settings')).toThrow()
    vi.spyOn(state.bindings, 'replacePrivateFile').mockReturnValueOnce({ ...evidence('file'), linkCount: 2 })
    expect(() => { files.replace('settings', Buffer.from('{}\n')) }).toThrow()
  })
})
