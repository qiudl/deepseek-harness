/** Independent native source metadata format; inspection never opens the source through SQLite. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HostAuthorityError } from './types.ts'

/** Literal application identifier of the independent native source format. */
export const NATIVE_SOURCE_APP_ID = 0x44534d33
/** Exact native-purpose catalog; released source and recipient catalogs remain separate. */
export const NATIVE_SOURCE_SCHEMAS = [
  [
    'table',
    'memory_identity',
    'CREATE TABLE memory_identity(id INTEGER PRIMARY KEY CHECK(id=1),profile_id TEXT NOT NULL,installation_id TEXT NOT NULL,public_key_digest TEXT NOT NULL,database_id TEXT NOT NULL,limits_json TEXT NOT NULL) STRICT',
  ],
  [
    'table',
    'memory_budget',
    "CREATE TABLE memory_budget(group_name TEXT PRIMARY KEY CHECK(group_name IN('permanent','transient')),actual_rows INTEGER NOT NULL CHECK(actual_rows>=0),actual_bytes INTEGER NOT NULL CHECK(actual_bytes>=0),charged_rows INTEGER NOT NULL CHECK(charged_rows>=actual_rows),charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=actual_bytes)) STRICT, WITHOUT ROWID",
  ],
  [
    'table',
    'memory_records',
    "CREATE TABLE memory_records(kind TEXT NOT NULL CHECK(kind IN('cut','published','delivery','frontier')),key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 256),payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(CAST(payload AS BLOB))<=131072),expires_at INTEGER,actual_bytes INTEGER NOT NULL CHECK(actual_bytes=length(CAST(payload AS BLOB))+length(CAST(key AS BLOB))+length(kind)+128),charged_rows INTEGER NOT NULL CHECK(charged_rows BETWEEN 1 AND 3),charged_bytes INTEGER NOT NULL CHECK(charged_bytes>=actual_bytes),CHECK((kind='published')=(expires_at IS NOT NULL)),CHECK(kind<>'delivery' OR json_extract(payload,'$.ack.participantRole') IS 'source_export'),PRIMARY KEY(kind,key)) STRICT, WITHOUT ROWID",
  ],
  [
    'index',
    'memory_native_published_expiry',
    "CREATE INDEX memory_native_published_expiry ON memory_records(kind,expires_at) WHERE kind='published'",
  ],
  [
    'table',
    'memory_ranges',
    "CREATE TABLE memory_ranges(scope TEXT NOT NULL CHECK(length(scope)=64 AND scope NOT GLOB '*[^0-9a-f]*'),start INTEGER NOT NULL CHECK(start>=0),finish INTEGER NOT NULL CHECK(finish>start),signature TEXT NOT NULL CHECK(length(signature)=86),PRIMARY KEY(scope,start)) STRICT, WITHOUT ROWID",
  ],
  ['index', 'memory_range_frontier', 'CREATE INDEX memory_range_frontier ON memory_ranges(scope,start,finish)'],
] as const
function fail(): never {
  throw new HostAuthorityError('unavailable')
}

/** Snapshot known main/WAL/SHM bytes under their actual read-only descriptors, before any source-side write.
 * @param path - Fixed held native-purpose database path selected by the private file owner.
 * @param expected - Original independently parsed private bootstrap identity.
 * @returns Nothing; unknown/mixed/corrupt sources are refused without touching their bytes or sidecars.
 */
export async function inspectNativeSourceFormat(
  path: string,
  expected: Readonly<{
    profileId: string
    installationId: string
    publicKeyDigest: string
    databaseId: string
    state: 'pending' | 'published'
  }>,
): Promise<void> {
  const sources: { fd: number; path: string; stat: Stats; digest: string }[] = []
  const folder = mkdtempSync(join(tmpdir(), 'dsh-native-source-inventory-'))
  const same = (a: Stats, b: Stats) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  const checksum = (fd: number, size: number) => {
    const hash = createHash('sha256'),
      bytes = Buffer.alloc(65536)
    for (let offset = 0; offset < size; ) {
      const count = readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset)
      if (!count) return fail()
      hash.update(bytes.subarray(0, count))
      offset += count
    }
    return hash.digest('hex')
  }
  try {
    for (const [suffix, maximum] of [
      ['', 3 * 1024 ** 3],
      ['-wal', 64 * 1024 ** 2],
      ['-shm', 16 * 1024 ** 2],
      ['-journal', 3 * 1024 ** 3],
    ] as const) {
      let stat: Stats
      try {
        stat = lstatSync(path + suffix)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (suffix !== '' || expected.state === 'pending'))
          continue
        throw error
      }
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > maximum ||
        (process.getuid !== undefined && stat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        fail()
      const fd = openSync(path + suffix, constants.O_RDONLY | constants.O_NOFOLLOW)
      const source = { fd, path: path + suffix, stat, digest: '' }
      sources.push(source)
      if (!same(stat, fstatSync(fd))) fail()
      const out = openSync(join(folder, 'memory.sqlite' + suffix), 'wx', 0o600)
      try {
        const bytes = Buffer.alloc(65536),
          hash = createHash('sha256')
        for (let offset = 0; offset < stat.size; ) {
          const count = readSync(fd, bytes, 0, Math.min(bytes.length, stat.size - offset), offset)
          if (!count) fail()
          hash.update(bytes.subarray(0, count))
          let written = 0
          while (written < count) written += writeSync(out, bytes, written, count - written)
          offset += count
        }
        source.digest = hash.digest('hex')
      } finally {
        closeSync(out)
      }
    }
    const current = () => {
      for (const source of sources)
        if (
          !same(source.stat, fstatSync(source.fd)) ||
          !same(source.stat, lstatSync(source.path)) ||
          checksum(source.fd, source.stat.size) !== source.digest ||
          !same(source.stat, fstatSync(source.fd))
        )
          fail()
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (sources.some(s => s.path === path + suffix)) continue
        try {
          lstatSync(path + suffix)
          fail()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    current()
    const main = sources.find(s => s.path === path),
      emptyCompanions = sources.every(s => s.path === path || s.stat.size === 0)
    if (expected.state === 'pending' && sources.some(s => s.path === path + '-journal' && s.stat.size !== 0))
      return fail()
    if (!main || main.stat.size === 0) {
      current()
      if (expected.state === 'pending' && emptyCompanions) return
      return fail()
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(folder, 'memory.sqlite'), { readOnly: true, allowExtension: false })
    try {
      const rows = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()
      const app = db.prepare('PRAGMA application_id').get()?.application_id,
        version = db.prepare('PRAGMA user_version').get()?.user_version
      if (
        expected.state === 'pending' &&
        emptyCompanions &&
        rows.length === 0 &&
        app === 0 &&
        version === 0 &&
        Number(db.prepare('PRAGMA page_count').get()?.page_count) <= 1
      ) {
        current()
        return
      }
      const catalog = [...NATIVE_SOURCE_SCHEMAS]
        .sort((a, b) => (a[1] < b[1] ? -1 : 1))
        .map(([type, name, sql]) => ({ type, name, sql }))
      if (
        app !== NATIVE_SOURCE_APP_ID ||
        version !== 1 ||
        JSON.stringify(rows) !== JSON.stringify(catalog) ||
        db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
      )
        fail()
      const identity = db.prepare('SELECT * FROM memory_identity WHERE id=1').get()
      if (
        !identity ||
        identity.profile_id !== expected.profileId ||
        identity.installation_id !== expected.installationId ||
        identity.public_key_digest !== expected.publicKeyDigest ||
        identity.database_id !== expected.databaseId
      )
        fail()
      let limits: unknown
      try {
        limits = JSON.parse(String(identity.limits_json))
      } catch {
        return fail()
      }
      if (
        !limits ||
        typeof limits !== 'object' ||
        Object.getPrototypeOf(limits) !== Object.prototype ||
        Object.keys(limits).sort().join(',') !== 'permanentBytes,permanentRows,transientBytes,transientRows'
      )
        fail()
      for (const [key, maximum] of Object.entries({
        permanentRows: 524288,
        permanentBytes: 2 * 1024 ** 3,
        transientRows: 4096,
        transientBytes: 16 * 1024 ** 2,
      })) {
        const value: unknown = Reflect.get(limits, key)
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) fail()
      }
      for (const transient of [false, true]) {
        const budget = db
          .prepare('SELECT * FROM memory_budget WHERE group_name=?')
          .get(transient ? 'transient' : 'permanent')
        const sum = db
          .prepare(
            "SELECT count(*) n,coalesce(sum(actual_bytes),0) bytes,coalesce(sum(charged_rows),0) charged_rows,coalesce(sum(charged_bytes),0) charged_bytes FROM memory_records WHERE (kind='published')=?",
          )
          .get(transient ? 1 : 0)
        if (!sum) fail()
        const ranges = transient ? 0 : Number(db.prepare('SELECT count(*) n FROM memory_ranges').get()?.n)
        if (
          !budget ||
          budget.actual_rows !== Number(sum.n) + ranges ||
          budget.actual_bytes !== Number(sum.bytes) + ranges * 320 ||
          budget.charged_rows !== Number(sum.charged_rows) + ranges ||
          budget.charged_bytes !== Number(sum.charged_bytes) + ranges * 320 ||
          budget.charged_rows > Reflect.get(limits, transient ? 'transientRows' : 'permanentRows') ||
          budget.charged_bytes > Reflect.get(limits, transient ? 'transientBytes' : 'permanentBytes')
        )
          fail()
      }
    } finally {
      db.close()
    }
    current()
  } finally {
    try {
      for (const source of sources) closeSync(source.fd)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }
}
