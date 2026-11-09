import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'
import {
  ProjectOperationMemoryDatabase,
  type ProjectMemoryDatabaseLimits,
} from '../src/project-operation-memory-database.ts'

function fixture(capacity?: ProjectMemoryDatabaseLimits) {
  const root = mkdtempSync(join(tmpdir(), 'req0006-memory-database-')),
    key = generateKeyPairSync('ed25519'),
    files: ProjectOperationMemoryDatabaseFiles[] = [],
    databases: ProjectOperationMemoryDatabase[] = []
  const options = {
    root: join(root, 'memory'),
    legacyRoots: [],
    uid: process.getuid!(),
    pid: process.pid,
    processNonce: randomUUID(),
    profileId: randomUUID(),
    installationId: randomUUID(),
    publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
  }
  onTestFinished(async () => {
    vi.restoreAllMocks()
    for (const db of databases) await db.close()
    for (const file of files) {
      file.releaseSidecars()
      await file.releaseAfterDatabaseClose()
    }
    rmSync(root, { recursive: true, force: true })
  })
  const openFiles = async () => {
    const value = await ProjectOperationMemoryDatabaseFiles.posix(options)
    files.push(value)
    return value
  }
  return {
    root,
    options,
    openFiles,
    signer: (bytes: Buffer) => sign(null, bytes, key.privateKey).toString('base64url'),
    async open() {
      const file = await openFiles(),
        db = await ProjectOperationMemoryDatabase.open(file, capacity)
      databases.push(db)
      return { db, file }
    },
  }
}

// These cases use actual POSIX owner-private files. Windows metadata contracts run in the dedicated native suites.
describe.skipIf(process.platform === 'win32')('POSIX private memory composition', () => {
  it('publishes an exact real SQLite schema, persists original keys and rolls back values and counters together', async () => {
    const f = fixture(),
      { db, file } = await f.open()
    expect(file.published).toBe(true)
    db.put('plan', 'original', { originalVersion: '9007199254740993' }, { rows: 1, bytes: 1024 }, () => {})
    const before = db.usage()
    expect(() =>
      db.transaction(
        () => {},
        () => {
          db.put('plan', 'rolled_back', { version: '2' }, { rows: 1, bytes: 1024 }, () => {})
          throw Error('crash before commit')
        },
      ),
    ).toThrow('crash before commit')
    expect(db.get('plan', 'rolled_back')).toBeNull()
    expect(db.usage()).toEqual(before)
    await db.close()
    const next = await f.open()
    expect(next.db.get('plan', 'original')).toEqual({ originalVersion: '9007199254740993' })
    expect(next.db.usage()).toEqual(before)
  })

  it('reserves future existing-ID growth at admission and rejects new IDs at quota without deleting tombstones', async () => {
    const f = fixture({ permanentRows: 2, permanentBytes: 4096, transientRows: 2, transientBytes: 4096 }),
      { db } = await f.open()
    db.put('plan', 'admitted', { state: 'pending' }, { rows: 2, bytes: 4000 }, () => {})
    expect(() => {
      db.put('plan', 'new', { state: 'new' }, { rows: 1, bytes: 256 }, () => {})
    }).toThrow()
    db.put(
      'plan',
      'admitted',
      { state: 'completed', receipt: 'original signed receipt' },
      { rows: 1, bytes: 256 },
      () => {},
    )
    expect(db.get('plan', 'admitted')).toMatchObject({ state: 'completed' })
    expect(db.usage().permanent.charged_rows).toBe(2)
    db.put('nonce', 'live', { expiresAt: 2000 }, { rows: 1, bytes: 256, expiresAt: 2000 }, () => {})
    db.removeTransient('nonce', { expiredAt: 1999 }, () => {})
    expect(db.get('nonce', 'live')).not.toBeNull()
    db.removeTransient('nonce', { expiredAt: 2000 }, () => {})
    expect(db.get('nonce', 'live')).toBeNull()
    expect(db.get('plan', 'admitted')).not.toBeNull()
  })

  it('completes only a known unpublished bootstrap and preserves unknown schema bytes on refusal', async () => {
    const f = fixture(),
      files = await f.openFiles()
    vi.spyOn(files, 'publish').mockImplementationOnce(() => {
      throw Error('marker publication interrupted')
    })
    await expect(ProjectOperationMemoryDatabase.open(files)).rejects.toThrow('marker publication interrupted')
    const complete = await f.open()
    expect(complete.file.published).toBe(true)
    await complete.db.close()
    const foreign = new DatabaseSync(complete.file.path)
    foreign.exec('CREATE TABLE unknown(value TEXT) STRICT')
    foreign.close()
    const before = readFileSync(complete.file.path)
    await expect(f.open()).rejects.toThrow()
    expect(readFileSync(complete.file.path)).toEqual(before)
  })

  it('retains writer ownership after a failed SQLite close and prevents late reads until confirmed shutdown', async () => {
    const f = fixture(),
      { db } = await f.open()
    const failure = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(() => {
      throw Error('native close failed')
    })
    await expect(db.close()).rejects.toThrow('native close failed')
    expect(() => db.get('plan', 'unknown')).toThrow()
    await expect(f.openFiles()).rejects.toThrow()
    failure.mockRestore()
    await db.close()
    const next = await f.open()
    expect(next.file.published).toBe(true)
  })

  it('recovers a killed real writer without publishing its unfinished transaction or losing earlier permanent IDs', async () => {
    const { spawnSync } = await import('node:child_process')
    const f = fixture(),
      first = await f.open()
    first.db.put('plan', 'original', { version: '1' }, { rows: 1, bytes: 1024 }, () => {})
    await first.db.close()
    const source = `import { ProjectOperationMemoryDatabaseFiles } from ${JSON.stringify(new URL('../src/project-operation-memory-database-files.ts', import.meta.url).href)};
import { ProjectOperationMemoryDatabase } from ${JSON.stringify(new URL('../src/project-operation-memory-database.ts', import.meta.url).href)};
const options = JSON.parse(process.argv[1]); options.pid=process.pid;
const db=await ProjectOperationMemoryDatabase.open(await ProjectOperationMemoryDatabaseFiles.posix(options));
db.put('plan','committed',{version:'2'},{rows:1,bytes:1024},()=>{});
db.transaction(()=>{},()=>{db.put('plan','unfinished',{version:'3'},{rows:1,bytes:1024},()=>{});process.kill(process.pid,'SIGKILL')});`
    const killed = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source, JSON.stringify(f.options)],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 },
    )
    expect(killed.signal, killed.stderr).toBe('SIGKILL')
    const recovered = await f.open()
    expect(recovered.db.get('plan', 'original')).toEqual({ version: '1' })
    expect(recovered.db.get('plan', 'committed')).toEqual({ version: '2' })
    expect(recovered.db.get('plan', 'unfinished')).toBeNull()
    expect(recovered.db.usage().permanent.actual_rows).toBe(2)
  })

  it('uses indexed bounded range work for a large gap, exact int64 coordinates and atomic rollback', async () => {
    const f = fixture(),
      { db } = await f.open(),
      scope = 'a'.repeat(64),
      start = performance.now(),
      count = 12000
    // Ascending disjoint intervals expose implementations which rescan all historical starts on every insert.
    db.transaction(
      () => {},
      () => {
        for (let i = 1; i <= count; i++)
          expect(db.mergeDelta(scope, BigInt(i * 3), BigInt(i * 3 + 1), 0n, () => {}, f.signer)).toBe(0n)
      },
    )
    const before = db.usage()
    expect(() =>
      db.transaction(
        () => {},
        () => {
          expect(db.mergeDelta(scope, 0n, BigInt(count * 3), 0n, () => {}, f.signer)).toBe(BigInt(count * 3 + 1))
          throw Error('receipt transaction failed')
        },
      ),
    ).toThrow('receipt transaction failed')
    expect(db.usage()).toEqual(before)
    expect(db.mergeDelta(scope, 0n, BigInt(count * 3), 0n, () => {}, f.signer)).toBe(BigInt(count * 3 + 1))
    expect(db.usage().permanent.actual_rows).toBe(0)
    const exact = 9007199254740993n
    expect(db.mergeDelta('b'.repeat(64), exact + 2n, exact + 4n, exact, () => {}, f.signer)).toBe(exact)
    expect(db.mergeDelta('b'.repeat(64), exact, exact + 2n, exact, () => {}, f.signer)).toBe(exact + 4n)
    expect(db.mergeDelta(scope, 0n, 0n, 1n, () => {}, f.signer)).toBe(1n)
    expect(() => db.mergeDelta(scope, 0n, 2n, 9223372036854775808n, () => {}, f.signer)).toThrow()
    expect(performance.now() - start).toBeLessThan(15000)
  }, 20000)

  it('refuses changed application identity, schema, accounting and published read-only storage without repair', async () => {
    for (const sql of [
      'PRAGMA application_id=42',
      'PRAGMA user_version=2',
      "UPDATE memory_identity SET installation_id='foreign'",
      "DELETE FROM memory_budget WHERE group_name='permanent'",
      "UPDATE memory_budget SET charged_bytes=1 WHERE group_name='permanent'",
      'CREATE VIEW injected AS SELECT 1',
      'CREATE TRIGGER injected AFTER INSERT ON memory_records BEGIN SELECT 1; END',
    ]) {
      const f = fixture(),
        original = await f.open()
      await original.db.close()
      const raw = new DatabaseSync(original.file.path)
      raw.exec(sql)
      raw.close()
      const bytes = readFileSync(original.file.path)
      await expect(f.open()).rejects.toThrow()
      expect(readFileSync(original.file.path), sql).toEqual(bytes)
    }
    const f = fixture(),
      owner = await f.open()
    await owner.db.close()
    const { chmodSync } = await import('node:fs')
    chmodSync(owner.file.path, 0o400)
    await expect(f.open()).rejects.toThrow()
    chmodSync(owner.file.path, 0o600)
  })
  it('rejects invalid admission bounds, oversized or nonobject metadata and asynchronous transaction work', async () => {
    const f = fixture(),
      files = await f.openFiles()
    await expect(
      ProjectOperationMemoryDatabase.open(files, {
        permanentRows: 0,
        permanentBytes: 1,
        transientRows: 1,
        transientBytes: 1,
      }),
    ).rejects.toThrow()
    // Invalid trusted configuration has not opened SQLite or accepted any request.
    files.releaseSidecars()
    await files.releaseAfterDatabaseClose()
    const { db } = await f.open()
    for (const bad of [
      null,
      [],
      { value: 'x'.repeat(131072) },
      {
        toJSON() {
          return undefined
        },
      },
    ])
      expect(() => {
        db.put('plan', 'invalid', bad, { rows: 1, bytes: 256 }, () => {})
      }).toThrow()
    expect(() =>
      db.transaction(
        () => {},
        async () => 'not synchronous',
      ),
    ).toThrow()
    expect(() =>
      db.transaction(
        () => {},
        () =>
          db.transaction(
            () => {},
            async () => 'nested asynchronous',
          ),
      ),
    ).toThrow()
    expect(() => {
      db.put('plan', 'bad-reservation', {}, { rows: 0, bytes: 256 }, () => {})
    }).toThrow()
    expect(() => {
      db.put('nonce', 'bad-expiry', {}, { rows: 1, bytes: 256 }, () => {})
    }).toThrow()
    expect(() => {
      db.removeTransient('nonce', { expiredAt: -1 }, () => {})
    }).toThrow()
    expect(() => db.mergeDelta('invalid', 0n, 1n, 0n, () => {}, f.signer)).toThrow()
    const before = db.usage()
    let closing = Promise.resolve()
    db.transaction(
      () => {},
      () => {
        closing = db.close()
        void closing.catch(() => {})
      },
    )
    await expect(closing).rejects.toThrow()
    // Closing inside a transaction permanently quiesces the owner; no writer lease is released while work is live.
    expect(() => db.usage()).toThrow()
    expect(before.permanent.actual_rows).toBe(0)
  })

  it('rejects forged derived endpoints before they can bridge a gap or enlarge a verified committed interval', async () => {
    const f = fixture(),
      { db, file } = await f.open(),
      scope = 'c'.repeat(64)
    expect(db.mergeDelta(scope, 4n, 8n, 0n, () => {}, f.signer)).toBe(0n)
    const raw = new DatabaseSync(file.path)
    raw.prepare('UPDATE memory_ranges SET finish=100 WHERE scope=?').run(scope)
    const before = db.usage()
    expect(() => db.mergeDelta(scope, 0n, 4n, 0n, () => {}, f.signer)).toThrow()
    expect(db.usage()).toEqual(before)
    raw.prepare('UPDATE memory_ranges SET finish=8,start=1 WHERE scope=?').run(scope)
    expect(() => db.mergeDelta(scope, 6n, 9n, 0n, () => {}, f.signer)).toThrow()
    raw.close()
    expect(() =>
      db.mergeDelta(
        'd'.repeat(64),
        3n,
        4n,
        0n,
        () => {},
        () => 'A'.repeat(86),
      ),
    ).toThrow()
  })

  it('rolls back interrupted schema bootstrap and retains ownership if that cleanup itself fails', async () => {
    const f = fixture(),
      files = await f.openFiles(),
      exec = Reflect.get(DatabaseSync.prototype, 'exec')
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      exec.call(this, sql)
      if (sql.startsWith('INSERT INTO memory_budget')) throw Error('disk failure before bootstrap commit')
    })
    await expect(ProjectOperationMemoryDatabase.open(files)).rejects.toThrow('disk failure before bootstrap commit')
    fault.mockRestore()
    const recovered = await f.open()
    expect(recovered.file.published).toBe(true)
    await recovered.db.close()
    const failedFiles = await f.openFiles(),
      close = vi
        .spyOn(failedFiles, 'releaseAfterDatabaseClose')
        .mockRejectedValueOnce(Error('native owner close failed'))
    await expect(
      ProjectOperationMemoryDatabase.open(failedFiles, {
        permanentRows: -1,
        permanentBytes: 1,
        transientRows: 1,
        transientBytes: 1,
      }),
    ).rejects.toThrow('project_memory_ownership_retained')
    await expect(f.openFiles()).rejects.toThrow()
    close.mockRestore()
    await failedFiles.releaseAfterDatabaseClose()
  })

  it('rejects live accounting and JSON corruption instead of using invalid private metadata', async () => {
    const f = fixture(),
      { db, file } = await f.open(),
      raw = new DatabaseSync(file.path)
    db.put('plan', 'original', { version: '1' }, { rows: 1, bytes: 1024 }, () => {})
    raw.exec(
      "PRAGMA ignore_check_constraints=ON; UPDATE memory_records SET payload='null',actual_bytes=4+length(key)+length(kind)+128 WHERE kind='plan'",
    )
    expect(() => db.get('plan', 'original')).toThrow()
    raw.exec("UPDATE memory_budget SET charged_rows=-1 WHERE group_name='permanent'")
    expect(() => db.usage()).toThrow()
    raw.exec("DELETE FROM memory_budget WHERE group_name='permanent'")
    expect(() => {
      db.put('plan', 'new', {}, { rows: 1, bytes: 256 }, () => {})
    }).toThrow()
    expect(() => db.usage()).toThrow()
    raw.close()
  })
  it('refuses invalid native integrity reports and a pending marker containing previously accepted identities', async () => {
    const corrupt = fixture(),
      before = await corrupt.open()
    await before.db.close()
    const raw = new DatabaseSync(before.file.path)
    raw.exec(
      "PRAGMA ignore_check_constraints=ON; UPDATE memory_budget SET charged_rows=-1 WHERE group_name='permanent'",
    )
    raw.close()
    await expect(corrupt.open()).rejects.toThrow()
    const f = fixture(),
      owner = await f.open()
    owner.db.put('plan', 'permanent', { version: '1' }, { rows: 1, bytes: 1024 }, () => {})
    await owner.db.close()
    const { writeFileSync } = await import('node:fs'),
      path = join(f.options.root, 'bootstrap', 'receipts.v1.json'),
      published = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...published, state: 'pending' }))
    await expect(f.open()).rejects.toThrow()
  })
  it('refuses unknown admission configuration and unsupported actual SQLite configuration without admitting requests', async () => {
    const f = fixture(),
      files = await f.openFiles(),
      unknown = { permanentRows: 2, permanentBytes: 4096, transientRows: 2, transientBytes: 4096, unknown: true }
    await expect(ProjectOperationMemoryDatabase.open(files, unknown)).rejects.toThrow()
    const next = await f.openFiles(),
      exec = Reflect.get(DatabaseSync.prototype, 'exec'),
      fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
        exec.call(this, sql.replace('wal_autocheckpoint=256', 'wal_autocheckpoint=1000'))
      })
    await expect(ProjectOperationMemoryDatabase.open(next)).rejects.toThrow()
    fault.mockRestore()
    expect((await f.open()).file.published).toBe(true)
  })
  it('keeps an uncertain committed identity for exact recovery when its final publication fence expires', async () => {
    const { db } = await fixture().open(),
      exec = Reflect.get(DatabaseSync.prototype, 'exec')
    let committed = false
    const observed = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      exec.call(this, sql)
      if (sql === 'COMMIT') committed = true
    })
    expect(() => {
      db.put('plan', 'original', { version: '1' }, { rows: 1, bytes: 1024 }, () => {
        if (committed) throw Error('current publication expired')
      })
    }).toThrow('current publication expired')
    observed.mockRestore()
    expect(db.get('plan', 'original')).toEqual({ version: '1' })
    expect(db.usage().permanent.actual_rows).toBe(1)
  })

  it('honors a failed native integrity report before any writable configuration or request admission', async () => {
    const f = fixture(),
      owner = await f.open()
    await owner.db.close()
    const prepare = Reflect.get(DatabaseSync.prototype, 'prepare'),
      fault = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
        return prepare.call(this, sql === 'PRAGMA quick_check' ? "SELECT 'integrity check failed' AS quick_check" : sql)
      })
    await expect(f.open()).rejects.toThrow()
    fault.mockRestore()
    expect((await f.open()).file.published).toBe(true)
  })
})
