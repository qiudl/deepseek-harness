import * as fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
    lstatSync: vi.fn(actual.lstatSync),
    fstatSync: vi.fn(actual.fstatSync),
  }
})
afterEach(() => vi.restoreAllMocks())

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'req0006-memory-files-')),
    key = generateKeyPairSync('ed25519')
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const options = {
    root: join(root, 'memory'),
    legacyRoots: [join(root, 'old-memory'), join(root, 'old-exports')],
    uid: process.getuid!(),
    pid: process.pid,
    processNonce: randomUUID(),
    profileId: randomUUID(),
    installationId: randomUUID(),
    publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
  }
  return { root, options, open: () => ProjectOperationMemoryDatabaseFiles.posix(options) }
}

it.skipIf(process.platform === 'win32')(
  'holds real private main/WAL/SHM files and one writer through SQLite close before ownership release',
  async () => {
    const f = fixture(),
      files = await f.open()
    const db = new DatabaseSync(files.path)
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE actual(value TEXT) STRICT')
      files.assertCurrent()
      files.publish()
      expect(files.published).toBe(true)
      for (const suffix of ['', '-wal', '-shm']) expect(statSync(files.path + suffix).mode & 0o777).toBe(0o600)
      await expect(f.open()).rejects.toThrow()
      await expect(files.releaseAfterDatabaseClose()).rejects.toThrow()
      await expect(f.open()).rejects.toThrow()
    } finally {
      files.releaseSidecars()
      db.close()
      await files.releaseAfterDatabaseClose()
    }
    const reopened = await f.open()
    expect(reopened.published).toBe(true)
    reopened.releaseSidecars()
    await reopened.releaseAfterDatabaseClose()
  },
)

it.skipIf(process.platform === 'win32')(
  'refuses published empty/missing/replaced main files instead of reopening an empty ledger',
  async () => {
    for (const fault of ['empty', 'missing', 'replaced'] as const) {
      const f = fixture(),
        files = await f.open(),
        db = new DatabaseSync(files.path)
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE actual(value TEXT) STRICT')
      files.publish()
      files.releaseSidecars()
      db.close()
      await files.releaseAfterDatabaseClose()
      if (fault === 'empty') writeFileSync(files.path, '')
      else {
        unlinkSync(files.path)
        if (fault === 'replaced') writeFileSync(files.path, 'foreign', { mode: 0o600 })
      }
      await expect(f.open()).rejects.toThrow()
      if (fault === 'empty') expect(readFileSync(files.path)).toHaveLength(0)
      if (fault === 'missing') expect(() => statSync(files.path)).toThrow()
      if (fault === 'replaced') expect(readFileSync(files.path, 'utf8')).toBe('foreign')
    }
  },
)

it.skipIf(process.platform === 'win32')(
  'preserves foreign files and known candidate JSON during read-only inventory',
  async () => {
    const f = fixture()
    mkdirSync(f.options.legacyRoots[0]!, { recursive: true, mode: 0o700 })
    const old = join(f.options.legacyRoots[0]!, 'receipts.v1.json')
    writeFileSync(old, '{"version":1,"candidate":"kept"}', { mode: 0o600 })
    await expect(f.open()).rejects.toThrow()
    expect(readFileSync(old, 'utf8')).toBe('{"version":1,"candidate":"kept"}')
    const other = fixture()
    mkdirSync(other.options.root, { recursive: true, mode: 0o700 })
    const path = join(other.options.root, 'memory.v1.sqlite')
    writeFileSync(path, 'foreign database', { mode: 0o600 })
    await expect(other.open()).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('foreign database')
  },
)

function windowsFixture() {
  const userSid = 'S-1-5-21-1000-2000-3000-1001',
    root = String.raw`C:\Users\alice\AppData\Local\Slark\memory`,
    rows = new Map<string, { bytes: Buffer; identity: string }>(),
    events: string[] = []
  let next = 1,
    held = false,
    failRelease = '',
    unsafe = false
  const evidence = (kind: 'directory' | 'file') => ({
    kind,
    reparsePoint: false,
    linkCount: 1,
    ownerSid: userSid,
    daclProtected: true,
    access: [userSid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({
      sid,
      type: 'allow' as const,
      mask: 0x1f01ff,
      inherited: false,
      objectInherit: true,
      containerInherit: true,
    })),
  })
  const missing = () => Object.assign(Error('missing'), { win32Code: 2 })
  const bindings: import('../src/windows-host-registration.ts').WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory: () => evidence('directory'),
    readPrivateFile(path, maximum) {
      const row = rows.get(path)
      if (!row) return undefined
      if (row.bytes.length > maximum) throw Error('size inventory refused')
      return { contents: Buffer.from(row.bytes), evidence: evidence('file') }
    },
    createPrivateFile(path, bytes) {
      if (rows.has(path)) return { state: 'exists', evidence: evidence('file') }
      rows.set(path, { bytes: Buffer.from(bytes), identity: '1:' + String(next++) })
      return { state: 'created', evidence: evidence('file') }
    },
    replacePrivateFile(path, bytes) {
      rows.set(path, { bytes: Buffer.from(bytes), identity: '1:' + String(next++) })
      return evidence('file')
    },
    removePrivateFile(path, expected, _sid, guard) {
      const row = rows.get(path)
      if (!row || !row.bytes.equals(expected)) throw Error('wrong journal')
      guard()
      rows.delete(path)
    },
    acquirePrivateFileLease(_path) {
      if (held) throw Error('writer held')
      held = true
      return {
        evidence: evidence('file'),
        initialize() {},
        release() {
          events.push('owner')
          held = false
        },
      }
    },
    acquirePrivateDatabaseFile(path, _sddl, mode) {
      let row = rows.get(path)
      const state = row ? ('existing' as const) : ('created' as const)
      if (!row) {
        if (mode === 'existing') throw missing()
        row = { bytes: Buffer.alloc(0), identity: '1:' + String(next++) }
        rows.set(path, row)
      }
      const original = row
      let released = false
      const inspect = () => {
        if (released || rows.get(path) !== original) throw Error('held file changed')
        return {
          evidence: { ...evidence('file'), reparsePoint: unsafe },
          byteLength: BigInt(original.bytes.length),
          fileIdentity: original.identity,
        }
      }
      return {
        state,
        evidence: evidence('file'),
        byteLength: BigInt(row.bytes.length),
        fileIdentity: row.identity,
        inspect,
        release() {
          if (released) return
          if (path.endsWith(failRelease) && failRelease) throw Error('native close failed')
          events.push(path)
          released = true
        },
      }
    },
  }
  const options = {
    root,
    legacyRoots: [],
    userSid,
    pid: process.pid,
    processNonce: randomUUID(),
    bindings,
    profileId: randomUUID(),
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 7).toString('base64url'),
  }
  return {
    options,
    rows,
    events,
    get held() {
      return held
    },
    fail(value: string) {
      failRelease = value
    },
    unsafe(value: boolean) {
      unsafe = value
    },
    open: () => ProjectOperationMemoryDatabaseFiles.windows(options),
  }
}

it('orders Windows metadata guard closure before owner release and never recreates a missing published main file', async () => {
  const f = windowsFixture(),
    files = await f.open()
  f.rows.get(files.path)!.bytes = Buffer.from('durable schema fixture')
  files.publish()
  expect(files.published).toBe(true)
  f.events.length = 0
  files.releaseSidecars()
  await files.releaseAfterDatabaseClose()
  expect(f.events).toEqual([files.path + '-wal', files.path + '-shm', files.path, 'owner'])
  const reopened = await f.open()
  reopened.releaseSidecars()
  await reopened.releaseAfterDatabaseClose()
  f.rows.delete(files.path)
  await expect(f.open()).rejects.toThrow('missing')
  expect(f.rows.has(files.path)).toBe(false)
  expect(f.held).toBe(false)
})
it('keeps Windows writer ownership on sidecar close failure and rejects missing native admission or unsafe evidence', async () => {
  const f = windowsFixture(),
    files = await f.open()
  f.fail('-wal')
  expect(() => {
    files.releaseSidecars()
  }).toThrow('native close failed')
  expect(f.held).toBe(true)
  f.fail('')
  files.releaseSidecars()
  await files.releaseAfterDatabaseClose()
  expect(f.held).toBe(false)
  const missing = windowsFixture()
  const missingBindings = { ...missing.options.bindings }
  delete missingBindings.acquirePrivateDatabaseFile
  await expect(
    ProjectOperationMemoryDatabaseFiles.windows({ ...missing.options, bindings: missingBindings }),
  ).rejects.toThrow()
  const unsafe = windowsFixture()
  unsafe.unsafe(true)
  await expect(unsafe.open()).rejects.toThrow()
  expect(unsafe.held).toBe(false)
})
it('refuses published Windows rollback journals and preserves known legacy metadata without repair', async () => {
  const f = windowsFixture(),
    files = await f.open()
  f.rows.get(files.path)!.bytes = Buffer.from('schema fixture')
  files.publish()
  files.releaseSidecars()
  await files.releaseAfterDatabaseClose()
  f.rows.set(files.path + '-journal', { bytes: Buffer.from('unexpected'), identity: '1:999' })
  await expect(f.open()).rejects.toThrow()
  expect(f.rows.get(files.path + '-journal')?.bytes.toString()).toBe('unexpected')
  const legacy = windowsFixture(),
    oldRoot = legacy.options.root + '-old',
    path = oldRoot + '\\receipts.v1.json'
  legacy.rows.set(path, { bytes: Buffer.from('{"version":1}'), identity: '1:999' })
  await expect(
    ProjectOperationMemoryDatabaseFiles.windows({ ...legacy.options, legacyRoots: [oldRoot] }),
  ).rejects.toThrow()
  expect(legacy.rows.get(path)?.bytes.toString()).toBe('{"version":1}')
})

it.skipIf(process.platform === 'win32')(
  'refuses unsafe POSIX paths, changed held identities, oversized sidecars and empty bootstrap publication',
  async () => {
    const { chmodSync, truncateSync, symlinkSync } = await import('node:fs')
    const invalid = fixture()
    await expect(ProjectOperationMemoryDatabaseFiles.posix({ ...invalid.options, root: 'relative' })).rejects.toThrow()
    await expect(
      ProjectOperationMemoryDatabaseFiles.posix({ ...invalid.options, profileId: 'invalid' }),
    ).rejects.toThrow()
    mkdirSync(invalid.options.root, { recursive: true, mode: 0o700 })
    chmodSync(invalid.options.root, 0o755)
    await expect(invalid.open()).rejects.toThrow()
    chmodSync(invalid.options.root, 0o700)
    const f = fixture(),
      files = await f.open()
    expect(() => {
      files.publish()
    }).toThrow()
    for (const [suffix, maximum] of [
      ['', 3 * 1024 ** 3],
      ['-wal', 64 * 1024 ** 2],
      ['-shm', 16 * 1024 ** 2],
    ] as const) {
      truncateSync(files.path + suffix, maximum + 1)
      expect(() => {
        files.assertCurrent()
      }).toThrow()
      truncateSync(files.path + suffix, 0)
    }
    chmodSync(files.path, 0o644)
    expect(() => {
      files.assertCurrent()
    }).toThrow()
    chmodSync(files.path, 0o600)
    const original = files.path + '.original'
    const { renameSync } = await import('node:fs')
    renameSync(files.path, original)
    symlinkSync(original, files.path)
    expect(() => {
      files.assertCurrent()
    }).toThrow()
    unlinkSync(files.path)
    renameSync(original, files.path)
    files.releaseSidecars()
    expect(() => {
      files.assertCurrent()
    }).toThrow()
    await files.releaseAfterDatabaseClose()
    expect(() => {
      files.assertCurrent()
    }).toThrow()
  },
)
it.skipIf(process.platform === 'win32')(
  'rejects malformed or mismatched durable bootstrap markers without changing their bytes',
  async () => {
    const f = fixture(),
      files = await f.open(),
      path = join(f.options.root, 'bootstrap', 'receipts.v1.json')
    files.releaseSidecars()
    await files.releaseAfterDatabaseClose()
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    for (const bad of [
      null,
      {},
      { ...original, extra: true },
      { ...original, profileId: randomUUID() },
      { ...original, state: 'unknown' },
      { ...original, databaseId: 'bad' },
      { ...original, mainFileIdentity: {} },
      { ...original, state: 'published', mainFileIdentity: null },
    ]) {
      const bytes = JSON.stringify(bad)
      writeFileSync(path, bytes)
      await expect(f.open()).rejects.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(bytes)
    }
    writeFileSync(path, ' '.repeat(16385))
    await expect(f.open()).rejects.toThrow()
    writeFileSync(path, JSON.stringify(original))
    const pending = await f.open()
    pending.releaseSidecars()
    await pending.releaseAfterDatabaseClose()
  },
)
it.skipIf(process.platform === 'win32')(
  'preserves a nonempty known bootstrap journal and refuses unexpected journal creation after publication',
  async () => {
    const f = fixture(),
      files = await f.open()
    writeFileSync(files.path + '-journal', 'interrupted journal', { mode: 0o600 })
    writeFileSync(files.path, 'schema fixture')
    expect(() => {
      files.publish()
    }).toThrow()
    expect(readFileSync(files.path + '-journal', 'utf8')).toBe('interrupted journal')
    writeFileSync(files.path + '-journal', '')
    files.publish()
    writeFileSync(files.path + '-journal', 'unexpected', { mode: 0o600 })
    expect(() => {
      files.assertCurrent()
    }).toThrow()
    unlinkSync(files.path + '-journal')
    files.releaseSidecars()
    await files.releaseAfterDatabaseClose()
  },
)

it('retains Windows bootstrap ownership when native acquisition cleanup cannot confirm release', async () => {
  const f = windowsFixture(),
    acquire = f.options.bindings.acquirePrivateDatabaseFile!
  f.options.bindings.acquirePrivateDatabaseFile = (path, sddl, mode) => {
    if (path.endsWith('-shm')) throw Error('native SHM admission failure')
    return acquire(path, sddl, mode)
  }
  f.fail('-wal')
  await expect(f.open()).rejects.toThrow('project_memory_ownership_retained')
  expect(f.held).toBe(true)
  const unsafe = windowsFixture()
  unsafe.unsafe(true)
  unsafe.fail('.sqlite')
  await expect(unsafe.open()).rejects.toThrow('project_memory_ownership_retained')
  expect(unsafe.held).toBe(true)
})
it('refuses Windows journal access errors and missing narrow journal deletion support', async () => {
  const f = windowsFixture(),
    acquire = f.options.bindings.acquirePrivateDatabaseFile!
  let denied = false
  f.options.bindings.acquirePrivateDatabaseFile = (path, sddl, mode) => {
    if (denied && path.endsWith('-journal') && mode === 'existing')
      throw Object.assign(Error('access denied'), { win32Code: 5 })
    return acquire(path, sddl, mode)
  }
  const files = await f.open()
  f.rows.get(files.path)!.bytes = Buffer.from('schema fixture')
  denied = true
  expect(() => {
    files.publish()
  }).toThrow('access denied')
  denied = false
  const remove = f.options.bindings.removePrivateFile?.bind(f.options.bindings)
  delete f.options.bindings.removePrivateFile
  expect(() => {
    files.publish()
  }).toThrow()
  f.options.bindings.removePrivateFile = remove!
  files.publish()
  files.releaseSidecars()
  await files.releaseAfterDatabaseClose()
})

it.skipIf(process.platform === 'win32')(
  'fails closed on native journal inspection errors and both successful and uncertain failed-acquire cleanup',
  async () => {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs'),
      f = fixture(),
      files = await f.open()
    writeFileSync(files.path, 'schema fixture')
    const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      if (String(args[0]).endsWith('-journal')) throw Object.assign(Error('journal access denied'), { code: 'EACCES' })
      return Reflect.apply(native.lstatSync, native, args)
    })
    expect(() => {
      files.publish()
    }).toThrow('journal access denied')
    inspect.mockRestore()
    files.releaseSidecars()
    await files.releaseAfterDatabaseClose()
    for (const uncertain of [false, true]) {
      const next = fixture(),
        paths = new Map<number, string>(),
        held = new Set<number>()
      const open = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
        const fd = native.openSync(...args)
        paths.set(fd, String(args[0]))
        held.add(fd)
        return fd
      })
      const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        if (uncertain && paths.get(fd)?.endsWith('memory.v1.sqlite')) throw Error('native close uncertain')
        native.closeSync(fd)
        held.delete(fd)
      })
      const stat = vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
        if (paths.get(args[0])?.endsWith('memory.v1.sqlite')) throw Error('native inspection failed')
        return Reflect.apply(native.fstatSync, native, args)
      })
      try {
        await expect(next.open()).rejects.toThrow(
          uncertain ? 'project_memory_ownership_retained' : 'native inspection failed',
        )
        if (uncertain) await expect(next.open()).rejects.toThrow()
      } finally {
        stat.mockRestore()
        close.mockRestore()
        open.mockRestore()
        for (const fd of held) native.closeSync(fd)
      }
    }
  },
)
it.skipIf(process.platform === 'win32')(
  'bounds pending bootstrap journals and rejects even empty legacy candidate files on both platforms',
  async () => {
    const { truncateSync } = await import('node:fs'),
      f = fixture(),
      files = await f.open()
    files.releaseSidecars()
    await files.releaseAfterDatabaseClose()
    truncateSync(files.path + '-journal', 3 * 1024 ** 3 + 1)
    await expect(f.open()).rejects.toThrow()
    truncateSync(files.path + '-journal', 0)
    const recovered = await f.open()
    recovered.releaseSidecars()
    await recovered.releaseAfterDatabaseClose()
    const legacy = fixture()
    mkdirSync(legacy.options.legacyRoots[0]!, { recursive: true, mode: 0o700 })
    writeFileSync(join(legacy.options.legacyRoots[0]!, 'receipts.v1.json'), '', { mode: 0o600 })
    await expect(legacy.open()).rejects.toThrow()
    const win = windowsFixture(),
      old = win.options.root + '-old'
    win.rows.set(old + '\\receipts.v1.json', { bytes: Buffer.alloc(0), identity: '1:999' })
    await expect(ProjectOperationMemoryDatabaseFiles.windows({ ...win.options, legacyRoots: [old] })).rejects.toThrow()
  },
)
