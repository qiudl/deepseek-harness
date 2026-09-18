import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyClaimRecoveryStore } from '../src/legacy-claim-recovery.ts'
import { FileLegacyClaimRecoveryFiles, WindowsLegacyClaimRecoveryFiles } from '../src/legacy-claim-recovery-files.ts'
import type { WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'

const profileId = 'b9e8b0aa-5c8e-4d4c-8e7a-139a86985f41'
const operationId = '97086a03-9508-41c0-bec3-7464dc835953'
const candidateId = 'llm-deepseek:deepseek'
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const windowsRoot = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\profiles`
const input = {
  profileId, operationId, candidateId, targetGeneration: 1,
  settingsBefore: Buffer.from('{"personal":"keep"}\n'),
  credentialsBefore: Buffer.from('{"version":1,"refs":{"PRIVATE":"secret"},"records":{}}\n'),
  settingsAfter: Buffer.from('{"personal":"keep","llm-deepseek":{"apiKeyEnv":"CLAIM"}}\n'),
  credentialsAfter: Buffer.from('{"version":1,"refs":{"PRIVATE":"secret","CLAIM":"old-secret"},"records":{}}\n'),
}
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function unixFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claim-recovery-'))
  dirs.push(root)
  mkdirSync(join(root, profileId), { mode: 0o700 })
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('unix_uid_required')
  return { root, uid, file: join(root, profileId, `legacy-model-claim-recovery.${operationId}.v1.json`) }
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
  const values = new Map<string, Buffer>()
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn((path: string) => {
      const contents = values.get(path)
      return contents === undefined ? undefined : { contents, evidence: evidence('file') }
    }),
    replacePrivateFile: vi.fn((path: string, contents: Buffer) => { values.set(path, Buffer.from(contents)); return evidence('file') }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  }
  return { values, bindings }
}

describe('legacy model claim recovery snapshot', () => {
  it('keeps an immutable, operation-scoped preimage across Unix restarts', () => {
    const { root, uid, file } = unixFixture()
    const store = new LegacyClaimRecoveryStore(new FileLegacyClaimRecoveryFiles(root, uid))
    expect(store.read(profileId, operationId)).toBeNull()
    const prepared = store.prepare(input)
    expect(readFileSync(file, 'utf8')).not.toContain('old-secret')
    expect(store.prepare(input)).toEqual(prepared)
    expect(new LegacyClaimRecoveryStore(new FileLegacyClaimRecoveryFiles(root, uid)).read(profileId, operationId))
      .toEqual(prepared)
    expect(() => store.prepare({ ...input, settingsBefore: Buffer.from('changed') })).toThrow()
    expect(store.prepare({ ...input, operationId: '2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3' }).operationId)
      .toBe('2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3')
    expect(store.restorable(prepared, input.settingsBefore, input.credentialsAfter)).toBe(true)
    expect(store.restorable(prepared, input.settingsAfter, input.credentialsBefore)).toBe(true)
    expect(store.restorable(prepared, Buffer.from('later edit'), input.credentialsAfter)).toBe(false)
    expect(store.restorable(prepared, input.settingsAfter, Buffer.from('later secret'))).toBe(false)
  })

  it('rejects corrupted snapshots and unsafe Unix files', () => {
    const { root, uid, file } = unixFixture()
    const files = new FileLegacyClaimRecoveryFiles(root, uid)
    const store = new LegacyClaimRecoveryStore(files)
    store.prepare(input)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const mutation of [
      { ...parsed, settingsBeforeDigest: '0'.repeat(64) },
      { ...parsed, operationId: '2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3' },
      { ...parsed, settingsBefore: '!!' },
      { ...parsed, extra: true },
    ]) {
      writeFileSync(file, JSON.stringify(mutation), { mode: 0o600 })
      expect(() => store.read(profileId, operationId)).toThrow()
    }
    writeFileSync(file, Buffer.from([0xff]), { mode: 0o600 })
    expect(() => store.read(profileId, operationId)).toThrow()
    writeFileSync(file, '{}', { mode: 0o600 })
    chmodSync(file, 0o644)
    expect(() => store.read(profileId, operationId)).toThrow()
    rmSync(file)
    const other = join(root, profileId, 'other')
    writeFileSync(other, '{}', { mode: 0o600 })
    linkSync(other, file)
    expect(() => store.read(profileId, operationId)).toThrow()
    rmSync(file)
    symlinkSync(other, file)
    expect(() => store.read(profileId, operationId)).toThrow()
  })

  it('uses Windows SID-private file bindings and rejects insecure evidence', () => {
    const state = windowsFixture()
    const files = new WindowsLegacyClaimRecoveryFiles({ profilesRoot: windowsRoot, userSid, bindings: state.bindings })
    const store = new LegacyClaimRecoveryStore(files)
    expect(store.prepare(input)).toEqual(store.read(profileId, operationId))
    expect(state.values.size).toBe(1)
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce({
      contents: Buffer.from('{}'), evidence: { ...evidence('file'), linkCount: 2 },
    })
    expect(() => store.read(profileId, operationId)).toThrow()
    vi.spyOn(state.bindings, 'ensurePrivateDirectory').mockReturnValueOnce({
      ...evidence('directory'), daclProtected: false,
    })
    expect(() => store.read(profileId, operationId)).toThrow()
  })

  it('rejects invalid operation input and missing durable publication', () => {
    const { root, uid } = unixFixture()
    const store = new LegacyClaimRecoveryStore(new FileLegacyClaimRecoveryFiles(root, uid))
    expect(() => store.read('bad', operationId)).toThrow()
    expect(() => store.read(profileId, 'bad')).toThrow()
    expect(() => store.prepare({ ...input, candidateId: '../bad' })).toThrow()
    expect(() => store.prepare({ ...input, settingsAfter: Buffer.alloc(16 * 1024 * 1024 + 1) })).toThrow()
    expect(() => store.prepare({ ...input, settingsBefore: 'bad' as never })).toThrow()
    const lost = new LegacyClaimRecoveryStore({ read: () => undefined, replace: () => undefined })
    expect(() => lost.prepare(input)).toThrow()
  })

  it('rejects malformed private snapshots before using their preimages', () => {
    const { root, uid, file } = unixFixture()
    const store = new LegacyClaimRecoveryStore(new FileLegacyClaimRecoveryFiles(root, uid))
    store.prepare(input)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const value of [Buffer.alloc(0), Buffer.from('null'), Buffer.from('[]'), Buffer.alloc(45 * 1024 * 1024 + 1)]) {
      writeFileSync(file, value)
      expect(() => store.read(profileId, operationId)).toThrow()
    }
    for (const value of [
      { ...saved, candidateId: 'bad' },
      { ...saved, version: 2 },
      { ...saved, settingsBefore: null },
    ]) {
      writeFileSync(file, JSON.stringify(value))
      expect(() => store.read(profileId, operationId)).toThrow()
    }
  })

  it('rejects unsafe paths and bounds both platform files', () => {
    const { root, uid, file } = unixFixture()
    expect(() => new FileLegacyClaimRecoveryFiles('relative', uid)).toThrow()
    expect(() => new FileLegacyClaimRecoveryFiles(root, -1)).toThrow()
    const files = new FileLegacyClaimRecoveryFiles(root, uid)
    expect(() => files.read('../bad', operationId)).toThrow()
    expect(() => files.read(profileId, '../bad')).toThrow()
    expect(() => { files.replace(profileId, operationId, Buffer.alloc(0)) }).toThrow()
    expect(() => { files.replace(profileId, operationId, Buffer.alloc(45 * 1024 * 1024 + 1)) }).toThrow()
    mkdirSync(file)
    expect(() => { files.replace(profileId, operationId, Buffer.from('{}')) }).toThrow()
    rmSync(file, { recursive: true })
    chmodSync(join(root, profileId), 0o777)
    expect(() => files.read(profileId, operationId)).toThrow()
    expect(() => new WindowsLegacyClaimRecoveryFiles({
      profilesRoot: `${windowsRoot}\\..\\bad`, userSid, bindings: windowsFixture().bindings,
    })).toThrow()
    const state = windowsFixture()
    const windows = new WindowsLegacyClaimRecoveryFiles({ profilesRoot: windowsRoot, userSid, bindings: state.bindings })
    expect(() => windows.read('../bad', operationId)).toThrow()
    expect(() => windows.read(profileId, '../bad')).toThrow()
    expect(() => { windows.replace(profileId, operationId, Buffer.alloc(0)) }).toThrow()
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce({
      contents: Buffer.alloc(45 * 1024 * 1024 + 1), evidence: evidence('file'),
    })
    expect(() => windows.read(profileId, operationId)).toThrow()
    vi.spyOn(state.bindings, 'replacePrivateFile').mockReturnValueOnce({ ...evidence('file'), linkCount: 2 })
    expect(() => { windows.replace(profileId, operationId, Buffer.from('{}')) }).toThrow()
  })
})
