import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createPosixTwinBindingReceiptFile, createWindowsTwinBindingReceiptFile } from '../src/twin-binding-receipt-files.ts'
import type { WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'
import { HostAuthorityError } from '../src/types.ts'

const faults = vi.hoisted(() => ({ directorySyncFailures: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: (fd: number) => {
    if (actual.fstatSync(fd).isDirectory() && faults.directorySyncFailures > 0) {
      faults.directorySyncFailures--
      throw Error('directory_sync_failed_after_rename')
    }
    actual.fsyncSync(fd)
  } }
})

it.skipIf(process.platform === 'win32')('persists POSIX bytes privately and preserves originals on a failed authority fence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-twin-receipt-'))
  try {
    const file = createPosixTwinBindingReceiptFile(root, process.getuid!())
    expect(file.read()).toBeUndefined()
    const bytes = Buffer.from('original committed bytes')
    file.write(bytes, () => {})
    const target = join(root, 'receipts.v1.json')
    expect(file.read()!.equals(bytes)).toBe(true)
    expect(lstatSync(target).mode & 0o777).toBe(0o600)
    expect(() =>{  file.write(Buffer.from('new'), () => { throw new HostAuthorityError('stale') }) }).toThrow('stale')
    expect(readFileSync(target).equals(bytes)).toBe(true)
    expect(createPosixTwinBindingReceiptFile(root, process.getuid!()).read()!.equals(bytes)).toBe(true)
    chmodSync(target, 0o644)
    expect(() => file.read()).toThrow('unavailable')
    expect(() =>{  file.ensureDurable(bytes) }).toThrow('unavailable')
    chmodSync(target, 0o600)
    const extra = join(root, 'hardlink')
    linkSync(target, extra)
    expect(() => file.read()).toThrow('unavailable')
    unlinkSync(extra)
    truncateSync(target, 16 * 1024 * 1024 + 1)
    expect(() => file.read()).toThrow('unavailable')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('rejects unsafe POSIX roots and symlinks without following receipt targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-twin-private-'))
  try {
    for (const [path, uid] of [['relative', process.getuid!()], [root, -1], [root, process.getuid!() + 1]] as const)
      expect(() => createPosixTwinBindingReceiptFile(path, uid)).toThrow('unavailable')
    chmodSync(root, 0o755)
    expect(() => createPosixTwinBindingReceiptFile(root, process.getuid!())).toThrow('unavailable')
    chmodSync(root, 0o700)
    const file = createPosixTwinBindingReceiptFile(root, process.getuid!())
    const source = join(root, 'original')
    writeFileSync(source, 'keep original', { mode: 0o600 })
    symlinkSync(source, join(root, 'receipts.v1.json'))
    expect(() => file.read()).toThrow('unavailable')
    expect(readFileSync(source, 'utf8')).toBe('keep original')
    const linkedRoot = root + '-link'
    symlinkSync(root, linkedRoot)
    try { expect(() => createPosixTwinBindingReceiptFile(linkedRoot, process.getuid!())).toThrow('unavailable') }
    finally { unlinkSync(linkedRoot) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('requires recovery barriers after rename succeeded but directory sync failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-twin-sync-fault-'))
  try {
    const file = createPosixTwinBindingReceiptFile(root, process.getuid!())
    const candidate = Buffer.from('original signed candidate')
    faults.directorySyncFailures = 1
    expect(() =>{  file.write(candidate, () => {}) }).toThrow('unavailable')
    expect(readFileSync(join(root, 'receipts.v1.json')).equals(candidate)).toBe(true)
    faults.directorySyncFailures = 1
    expect(() =>{  file.ensureDurable(candidate) }).toThrow('unavailable')
    expect(() =>{  file.ensureDurable(Buffer.from('different bytes')) }).toThrow('unavailable')
    file.ensureDurable(candidate)
    expect(file.read()!.equals(candidate)).toBe(true)
    unlinkSync(join(root, 'receipts.v1.json'))
    expect(() =>{  file.ensureDurable(candidate) }).toThrow('unavailable')
  } finally { faults.directorySyncFailures = 0; rmSync(root, { recursive: true, force: true }) }
})

const sid = 'S-1-5-21-1000-2000-3000-1001'
function evidence(kind: 'directory' | 'file'): WindowsHostPrivatePathEvidence {
  return { kind, reparsePoint: false, linkCount: 1, ownerSid: sid, daclProtected: true,
    access: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(owner => ({
      sid: owner, type: 'allow' as const, mask: 0x1F01FF, inherited: false,
      objectInherit: true, containerInherit: true,
    })) }
}
function windows() {
  let bytes: Buffer | undefined
  const bindings = {
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn(() => bytes === undefined ? undefined : { contents: bytes, evidence: evidence('file') }),
    replacePrivateFile: vi.fn((_path: string, value: Buffer) => { bytes = Buffer.from(value); return evidence('file') }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  } satisfies WindowsHostRegistrationFileBindings
  return { bindings, bytes: () => bytes,
    create: () => createWindowsTwinBindingReceiptFile('C:\\Users\\alice\\DSH\\profile\\twin-receipts', sid, bindings) }
}

it('uses Windows native private evidence and durable replacement for a fixed Host-derived path', () => {
  const f = windows(), file = f.create()
  expect(file.read()).toBeUndefined()
  const bytes = Buffer.from('native committed bytes')
  file.write(bytes, () => {})
  expect(f.create().read()!.equals(bytes)).toBe(true)
  expect(f.bindings.replacePrivateFile).toHaveBeenCalledWith(
    'C:\\Users\\alice\\DSH\\profile\\twin-receipts\\receipts.v1.json', bytes, expect.stringContaining(sid))
  expect(() =>{  file.write(Buffer.from('changed'), () => { throw new HostAuthorityError('stale') }) }).toThrow('stale')
  expect(f.bytes()!.equals(bytes)).toBe(true)
  vi.mocked(f.bindings.replacePrivateFile).mockImplementation(() => { throw Error('native failed') })
  expect(() =>{  file.write(bytes, () => {}) }).toThrow('unavailable')
  expect(f.bytes()!.equals(bytes)).toBe(true)
})

it('rejects unsafe Windows SID, DACL, link and reparse evidence without publishing new bytes', () => {
  for (const patch of [{ reparsePoint: true }, { ownerSid: 'S-1-5-21-999' }, { daclProtected: false }, { linkCount: 2 }]) {
    const f = windows(), file = f.create()
    file.write(Buffer.from('old'), () => {})
    vi.mocked(f.bindings.readPrivateFile).mockReturnValue({ contents: Buffer.from('old'),
      evidence: { ...evidence('file'), ...patch } })
    expect(() => file.read()).toThrow()
    expect(() =>{  file.ensureDurable(Buffer.from('old')) }).toThrow()
    expect(f.bindings.replacePrivateFile).toHaveBeenCalledTimes(1)
  }
  const root = windows()
  vi.mocked(root.bindings.ensurePrivateDirectory).mockReturnValue({ ...evidence('directory'), reparsePoint: true })
  expect(() => root.create()).toThrow()
  const published = windows(), file = published.create()
  vi.mocked(published.bindings.replacePrivateFile).mockReturnValue({ ...evidence('file'), reparsePoint: true })
  expect(() =>{  file.write(Buffer.from('new'), () => {}) }).toThrow()
  expect(() => createWindowsTwinBindingReceiptFile('relative', sid, published.bindings)).toThrow()
})

it('repeats Windows native write-through with identical validated bytes after a post-publication error', () => {
  const f = windows(), file = f.create(), original = f.bindings.replacePrivateFile.getMockImplementation()!
  const candidate = Buffer.from('original signed candidate')
  vi.mocked(f.bindings.replacePrivateFile).mockImplementation((...args) => {
    original(...args)
    throw Error('post_publication_failure')
  })
  expect(() =>{  file.write(candidate, () => {}) }).toThrow('unavailable')
  expect(f.bytes()!.equals(candidate)).toBe(true)
  expect(() =>{  file.ensureDurable(candidate) }).toThrow('unavailable')
  vi.mocked(f.bindings.replacePrivateFile).mockImplementation(original)
  expect(() =>{  file.ensureDurable(Buffer.from('different bytes')) }).toThrow('unavailable')
  file.ensureDurable(candidate)
  expect(f.bytes()!.equals(candidate)).toBe(true)
  const empty = windows()
  expect(() =>{  empty.create().ensureDurable(candidate) }).toThrow('unavailable')
})
