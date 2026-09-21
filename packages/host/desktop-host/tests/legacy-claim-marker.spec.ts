import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileProfileClaimMarkerFiles, ProfileClaimMarker, WindowsProfileClaimMarkerFiles,
  type ProfileClaimMarkerFiles,
} from '../src/legacy-claim-marker.ts'
import type { WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'

const profileId = 'b9e8b0aa-5c8e-4d4c-8e7a-139a86985f41'
const operationId = '97086a03-9508-41c0-bec3-7464dc835953'
const candidateId = 'llm-deepseek:deepseek'
const input = { profileId, operationId, candidateId }
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const windowsRoot = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\profiles`
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function unixFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claim-marker-'))
  dirs.push(root)
  const profileRoot = join(root, profileId)
  mkdirSync(profileRoot, { mode: 0o700 })
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('unix_uid_required')
  return { root, profileRoot, uid, file: join(profileRoot, 'legacy-model-claim.v1.json') }
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

function windowsFixture(contents?: Buffer) {
  let stored = contents
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn(() => stored === undefined ? undefined : { contents: stored, evidence: evidence('file') }),
    replacePrivateFile: vi.fn((_path, bytes) => { stored = Buffer.from(bytes); return evidence('file') }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  }
  return { bindings, stored: () => stored }
}

describe('Profile-local legacy claim startup marker', () => {
  it.skipIf(process.platform === 'win32')('marks and clears only the matching Profile operation across Unix restarts', () => {
    const options = unixFixture()
    const files = new FileProfileClaimMarkerFiles(options.root, options.uid)
    const marker = new ProfileClaimMarker(files)
    expect(marker.pending(profileId)).toBe(false)
    marker.mark(input)
    marker.mark(input)
    expect(new ProfileClaimMarker(new FileProfileClaimMarkerFiles(options.root, options.uid)).pending(profileId)).toBe(true)
    expect(JSON.parse(readFileSync(options.file, 'utf8'))).toEqual({ version: 1, ...input, state: 'pending' })
    expect(() => { marker.mark({ ...input, operationId: '2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3' }) }).toThrow()
    expect(() => { marker.clear({ ...input, candidateId: 'llm-pi-ai:custom' }) }).toThrow()
    marker.clear(input)
    marker.clear(input)
    expect(marker.pending(profileId)).toBe(false)
    marker.mark({ ...input, candidateId: 'llm-pi-ai:custom' })
    expect(marker.pending(profileId)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects corrupt and unsafe Unix marker files per Profile', () => {
    const options = unixFixture()
    const marker = new ProfileClaimMarker(new FileProfileClaimMarkerFiles(options.root, options.uid))
    for (const value of [
      Buffer.alloc(0), Buffer.alloc(2049), Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('{}'),
      Buffer.from(JSON.stringify({ version: 1, ...input, state: 'bad' })),
      Buffer.from(JSON.stringify({ version: 1, ...input, state: 'pending', extra: true })),
      Buffer.from(JSON.stringify({ version: 2, ...input, state: 'pending' })),
      Buffer.from(JSON.stringify({ version: 1, ...input, profileId: 'other', state: 'pending' })),
      Buffer.from(JSON.stringify({ version: 1, ...input, candidateId: 'bad', state: 'pending' })),
      Buffer.from(JSON.stringify({ version: 1, ...input, operationId: 'bad', state: 'pending' })),
    ]) {
      writeFileSync(options.file, value, { mode: 0o600 })
      expect(() => marker.pending(profileId)).toThrow()
    }
    chmodSync(options.file, 0o644)
    expect(() => marker.pending(profileId)).toThrow()
    rmSync(options.file)
    const other = join(options.profileRoot, 'other')
    writeFileSync(other, '{}', { mode: 0o600 })
    linkSync(other, options.file)
    expect(() => marker.pending(profileId)).toThrow()
    rmSync(options.file)
    symlinkSync(other, options.file)
    expect(() => marker.pending(profileId)).toThrow()
    rmSync(options.file)
    chmodSync(options.profileRoot, 0o777)
    expect(() => marker.pending(profileId)).toThrow()
  })

  it.skipIf(process.platform === 'win32')('rejects invalid inputs and only writes bounded bytes', () => {
    const options = unixFixture()
    expect(() => new FileProfileClaimMarkerFiles('relative', options.uid)).toThrow()
    expect(() => new FileProfileClaimMarkerFiles(options.root, -1)).toThrow()
    const files = new FileProfileClaimMarkerFiles(options.root, options.uid)
    const marker = new ProfileClaimMarker(files)
    expect(() => marker.pending('../escape')).toThrow()
    expect(() => { marker.mark({ ...input, operationId: 'bad' }) }).toThrow()
    expect(() => { marker.mark({ ...input, candidateId: 'bad' }) }).toThrow()
    expect(() => { marker.clear(input) }).toThrow()
    expect(() => { files.replace(profileId, Buffer.alloc(0)) }).toThrow()
    expect(() => { files.replace(profileId, Buffer.alloc(2049)) }).toThrow()
    expect(() => { files.read('../escape') }).toThrow()
    expect(() => { new FileProfileClaimMarkerFiles(options.root, options.uid).read('f100eb18-b77e-4693-abab-7d80750d9be4') }).toThrow()
  })

  it.skipIf(process.platform === 'win32')('cleans a Unix temporary file when marker publication fails', () => {
    const options = unixFixture()
    const files = new FileProfileClaimMarkerFiles(options.root, options.uid)
    const root = options.profileRoot
    rmSync(root, { recursive: true })
    mkdirSync(root, { mode: 0o700 })
    mkdirSync(options.file, { mode: 0o700 })
    expect(() => { files.replace(profileId, Buffer.from('{}')) }).toThrow()
    expect(readdirSync(root)).toEqual(['legacy-model-claim.v1.json'])
  })

  it('round-trips Windows markers through native SID-private files', () => {
    const state = windowsFixture()
    const files = new WindowsProfileClaimMarkerFiles({ profilesRoot: windowsRoot, userSid, bindings: state.bindings })
    const marker = new ProfileClaimMarker(files)
    expect(marker.pending(profileId)).toBe(false)
    marker.mark(input)
    expect(marker.pending(profileId)).toBe(true)
    marker.clear(input)
    expect(marker.pending(profileId)).toBe(false)
    expect(JSON.parse(state.stored()?.toString('utf8') ?? '')).toEqual({ version: 1, ...input, state: 'cleared' })
  })

  it('rejects malformed Windows roots, evidence, and size', () => {
    const state = windowsFixture()
    expect(() => new WindowsProfileClaimMarkerFiles({
      profilesRoot: `${windowsRoot}\\..\\bad`, userSid, bindings: state.bindings,
    })).toThrow()
    expect(() => new WindowsProfileClaimMarkerFiles({
      profilesRoot: windowsRoot, userSid: 'bad', bindings: state.bindings,
    })).toThrow()
    const files = new WindowsProfileClaimMarkerFiles({ profilesRoot: windowsRoot, userSid, bindings: state.bindings })
    expect(() => { files.read('../escape') }).toThrow()
    expect(() => { files.replace(profileId, Buffer.alloc(0)) }).toThrow()
    expect(() => { files.replace(profileId, Buffer.alloc(2049)) }).toThrow()
    vi.spyOn(state.bindings, 'ensurePrivateDirectory').mockReturnValueOnce({ ...evidence('directory'), daclProtected: false })
    expect(() => { files.read(profileId) }).toThrow()
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce({
      contents: Buffer.from('{}'), evidence: { ...evidence('file'), linkCount: 2 },
    })
    expect(() => { files.read(profileId) }).toThrow()
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce({
      contents: Buffer.alloc(2049), evidence: evidence('file'),
    })
    expect(() => { files.read(profileId) }).toThrow()
    vi.spyOn(state.bindings, 'replacePrivateFile').mockReturnValueOnce({ ...evidence('file'), linkCount: 2 })
    expect(() => { files.replace(profileId, Buffer.from('{}')) }).toThrow()
  })

  it('a missing or broken global ledger does not affect another Profile marker', () => {
    const events = new Map<string, Buffer>()
    const files: ProfileClaimMarkerFiles = {
      read: id => events.get(id), replace: (id, bytes) => { events.set(id, bytes) },
    }
    const marker = new ProfileClaimMarker(files)
    marker.mark(input)
    expect(marker.pending(profileId)).toBe(true)
    expect(marker.pending('f100eb18-b77e-4693-abab-7d80750d9be4')).toBe(false)
    expect(() => { marker.mark({ ...input, profileId: 'bad' }) }).toThrow()
    expect(() => { marker.clear({ ...input, operationId: 'bad' }) }).toThrow()
  })
})
