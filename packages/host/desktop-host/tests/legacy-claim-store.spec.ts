import { randomUUID } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyClaimLedger, type LegacyClaimEvent } from '../src/legacy-claim-ledger.ts'
import { FileLegacyClaimEventStore, WindowsLegacyClaimEventStore } from '../src/legacy-claim-store.ts'
import type {
  WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'

const reserved: LegacyClaimEvent = {
  kind: 'reserved', candidateId: 'llm-deepseek:deepseek', profileId: 'profile-a',
  operationId: 'operation-a', sourceDigest: 'a'.repeat(64), targetGeneration: 1, at: 1,
}
const committed: LegacyClaimEvent = {
  kind: 'committed', candidateId: reserved.candidateId, operationId: reserved.operationId, at: 2,
}
const windowsRoot = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\control`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claims-'))
  dirs.push(root)
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('unix_uid_required')
  return { root, uid, path: join(root, 'legacy-claims.v1.json'), maximumBytes: 4096 }
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
  return { bindings, stored: () => stored, setStored: (bytes: Buffer) => { stored = Buffer.from(bytes) } }
}

describe('legacy claim private snapshots', () => {
  it('atomically persists Unix claims and replays after Host restart', () => {
    const options = fixture()
    const store = new FileLegacyClaimEventStore(options)
    expect(store.read()).toEqual([])
    const ledger = new LegacyClaimLedger(store, () => 1)
    ledger.reserve({ ...reserved })
    expect(JSON.parse(readFileSync(options.path, 'utf8'))).toEqual({ version: 1, events: [reserved] })
    expect(new LegacyClaimLedger(new FileLegacyClaimEventStore(options), () => 2).hasPending('profile-a')).toBe(true)
    store.append(committed)
    expect(store.read()).toEqual([reserved, committed])
    expect(new LegacyClaimLedger(new FileLegacyClaimEventStore(options), () => 3).hasPending('profile-a')).toBe(false)
  })

  it('rejects malformed, oversized, and unsafe Unix snapshots', () => {
    const options = fixture()
    const store = new FileLegacyClaimEventStore(options)
    for (const contents of [
      Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('{}'),
      Buffer.from('{"version":2,"events":[]}'), Buffer.from('{"version":1,"events":[],"extra":1}'),
      Buffer.from('{"version":1,"events":{}}'),
      Buffer.from('{"version":1,"events":[{"kind":"bad"}]}'),
      Buffer.alloc(4097),
    ]) {
      writeFileSync(options.path, contents, { mode: 0o600 })
      expect(() => store.read()).toThrow()
    }
    writeFileSync(options.path, '{}', { mode: 0o600 })
    chmodSync(options.path, 0o644)
    expect(() => store.read()).toThrow()
    rmSync(options.path)
    const linked = join(options.root, 'linked')
    writeFileSync(linked, '{}', { mode: 0o600 })
    linkSync(linked, options.path)
    expect(() => store.read()).toThrow()
    rmSync(options.path)
    symlinkSync(linked, options.path)
    expect(() => store.read()).toThrow()
    rmSync(options.path)
    chmodSync(options.root, 0o777)
    expect(() => store.read()).toThrow()
  })

  it('validates Unix and Windows roots and rejects invalid append input and capacity', () => {
    const options = fixture()
    expect(() => new FileLegacyClaimEventStore({ ...options, root: 'relative' })).toThrow()
    expect(() => new FileLegacyClaimEventStore({ ...options, uid: -1 })).toThrow()
    expect(() => new FileLegacyClaimEventStore({ ...options, maximumBytes: 1 })).toThrow()
    const store = new FileLegacyClaimEventStore({ ...options, maximumBytes: 256 })
    expect(() => { store.append(null as never) }).toThrow()
    store.append(reserved)
    expect(() => { store.append(committed) }).toThrow()
    expect(store.read()).toEqual([reserved])
    const windows = windowsFixture()
    expect(() => new WindowsLegacyClaimEventStore({
      root: `${windowsRoot}\\..\\bad`, userSid, maximumBytes: 4096, bindings: windows.bindings,
    })).toThrow()
    expect(() => new WindowsLegacyClaimEventStore({
      root: windowsRoot, userSid: 'bad', maximumBytes: 4096, bindings: windows.bindings,
    })).toThrow()
  })

  it('round-trips Windows claims through the SID-owned native file authority', () => {
    const state = windowsFixture()
    const store = new WindowsLegacyClaimEventStore({
      root: windowsRoot, userSid, maximumBytes: 4096, bindings: state.bindings,
    })
    expect(store.read()).toEqual([])
    store.append(reserved)
    store.append(committed)
    expect(store.read()).toEqual([reserved, committed])
    expect(JSON.parse(state.stored()?.toString('utf8') ?? '')).toEqual({ version: 1, events: [reserved, committed] })
    expect(new LegacyClaimLedger(new WindowsLegacyClaimEventStore({
      root: windowsRoot, userSid, maximumBytes: 4096, bindings: state.bindings,
    }), () => 3).hasPending('profile-a')).toBe(false)
  })

  it('rejects unsafe Windows evidence and malformed persisted bytes', () => {
    const state = windowsFixture(Buffer.from('{}'))
    const store = new WindowsLegacyClaimEventStore({
      root: windowsRoot, userSid, maximumBytes: 4096, bindings: state.bindings,
    })
    expect(() => store.read()).toThrow()
    vi.spyOn(state.bindings, 'readPrivateFile').mockReturnValueOnce({
      contents: Buffer.from(JSON.stringify({ version: 1, events: [] })),
      evidence: { ...evidence('file'), reparsePoint: true },
    })
    expect(() => store.read()).toThrow()
    vi.spyOn(state.bindings, 'ensurePrivateDirectory')
      .mockReturnValueOnce({ ...evidence('directory'), daclProtected: false })
    expect(() => store.read()).toThrow()
    const clean = windowsFixture()
    vi.spyOn(clean.bindings, 'replacePrivateFile')
      .mockImplementationOnce((_path, bytes) => {
        clean.setStored(bytes)
        return { ...evidence('file'), linkCount: 2 }
      })
    const writer = new WindowsLegacyClaimEventStore({
      root: windowsRoot, userSid, maximumBytes: 4096, bindings: clean.bindings,
    })
    const ledger = new LegacyClaimLedger(writer, () => 1)
    expect(() => ledger.reserve({ ...reserved })).toThrow()
    expect(ledger.hasPending('profile-a')).toBe(true)
    expect(() => ledger.reserve({ ...reserved, operationId: randomUUID() })).toThrow()
    expect(new LegacyClaimLedger(new WindowsLegacyClaimEventStore({
      root: windowsRoot, userSid, maximumBytes: 4096, bindings: clean.bindings,
    }), () => 2).hasPending('profile-a')).toBe(true)
  })

  it('rejects a non-directory Unix root', () => {
    const options = fixture()
    const root = join(options.root, 'file')
    writeFileSync(root, '')
    expect(() => new FileLegacyClaimEventStore({ ...options, root })).toThrow()
  })

  it('cleans an uncommitted Unix temporary file when publication fails', () => {
    const options = fixture()
    const store = new FileLegacyClaimEventStore(options)
    vi.spyOn(store, 'read').mockImplementationOnce(() => {
      mkdirSync(options.path, { mode: 0o700 })
      return []
    })
    expect(() => { store.append(reserved) }).toThrow()
    expect(readdirSync(options.root)).toEqual(['legacy-claims.v1.json'])
  })
})
