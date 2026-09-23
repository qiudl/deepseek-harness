import { describe, expect, it, vi } from 'vitest'
import type {
  WindowsHostPrivatePathEvidence,
  WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'
import { WindowsHostJournal } from '../src/windows-host-journal.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\control`
const path = `${root}\\commands.jsonl`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const event = {
  kind: 'command_started' as const,
  profileId: 'profile-1',
  sessionId: 'session-1',
  commandId: 'command-1',
  payloadHash: 'a'.repeat(64),
  at: 1,
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

function fixture(contents?: Buffer) {
  let stored = contents
  const readPrivateFile = vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((_path, maximumBytes) => (
    stored === undefined ? undefined : {
      contents: stored.length > maximumBytes ? Buffer.alloc(maximumBytes + 1) : stored,
      evidence: evidence('file'),
    }
  ))
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    createPrivateFile: vi.fn<NonNullable<WindowsHostRegistrationFileBindings['createPrivateFile']>>(
      () => ({ state: 'created', evidence: evidence('file') }),
    ),
    readPrivateFile,
    replacePrivateFile: vi.fn((_path, next) => { stored = Buffer.from(next); return evidence('file') }),
    acquirePrivateFileLease: vi.fn(() => ({
      evidence: evidence('file'), initialize: vi.fn(), release: vi.fn(),
    })),
  }
  return { bindings, readPrivateFile, stored: () => stored }
}

describe('Windows Host command journal', () => {
  it('atomically appends and restores complete events through stable private files', () => {
    const state = fixture()
    const journal = new WindowsHostJournal({ root, userSid, maximumJournalBytes: 4096, bindings: state.bindings })
    expect(journal.read()).toEqual([])
    journal.append(event)
    expect(journal.read()).toEqual([event])
    expect(state.stored()?.toString('utf8')).toBe(`${JSON.stringify(event)}\n`)
  })

  it('rejects a partial journal, unsafe evidence, and size overflow', () => {
    expect(() => { new WindowsHostJournal({
      root, userSid, maximumJournalBytes: 4096, bindings: fixture(Buffer.from('{}')).bindings,
    }).read() }).toThrow()

    const unsafe = fixture(Buffer.from(`${JSON.stringify(event)}\n`))
    unsafe.readPrivateFile.mockReturnValueOnce({
      contents: Buffer.from(`${JSON.stringify(event)}\n`),
      evidence: { ...evidence('file'), reparsePoint: true },
    })
    expect(() => { new WindowsHostJournal({
      root, userSid, maximumJournalBytes: 4096, bindings: unsafe.bindings,
    }).read() }).toThrow()

    const full = fixture(Buffer.from(`${JSON.stringify(event)}\n`))
    const journal = new WindowsHostJournal({
      root, userSid, maximumJournalBytes: Buffer.byteLength(`${JSON.stringify(event)}\n`) + 1,
      bindings: full.bindings,
    })
    expect(() => { journal.append(event) }).toThrow()
  })

  it('rejects an invalid root and malformed event rows', () => {
    const malformed = fixture(Buffer.from('{"kind":"unknown"}\n'))
    const journal = new WindowsHostJournal({ root, userSid, maximumJournalBytes: 4096, bindings: malformed.bindings })
    expect(() => { journal.read() }).toThrow()
    expect(() => { journal.append(null as never) }).toThrow()
    expect(() => { journal.append([] as never) }).toThrow()
    expect(() => { new WindowsHostJournal({
      root: String.raw`C:\Users\alice\AppData\Local\Slark\DSH\control\..\legacy`,
      userSid,
      maximumJournalBytes: 4096,
      bindings: malformed.bindings,
    }) }).toThrow()
    expect(path).toContain('commands.jsonl')

    expect(() => { new WindowsHostJournal({
      root, userSid, maximumJournalBytes: 1, bindings: fixture(Buffer.alloc(2)).bindings,
    }).read() }).toThrow()
    expect(() => { new WindowsHostJournal({
      root, userSid, maximumJournalBytes: 4096, bindings: fixture(Buffer.from([0xff, 0x0a])).bindings,
    }).read() }).toThrow()
  })

  it('rejects an event that cannot round-trip to the durable schema', () => {
    const state = fixture()
    const journal = new WindowsHostJournal({ root, userSid, maximumJournalBytes: 4096, bindings: state.bindings })
    expect(() => { journal.append({
      ...event,
      kind: 'command_committed',
      outcome: undefined,
    }) }).toThrow()
    expect(state.stored()).toBeUndefined()
  })
})
