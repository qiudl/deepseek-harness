/** Real independent native format, synthetic metadata; no Cloud or retained Right is created here. */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'
import { ProjectOperationMemoryNativeDatabase } from '../src/project-operation-memory-native-database.ts'
import { ProjectOperationMemoryDatabase } from '../src/project-operation-memory-database.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'req0006-native-format-')),
    key = generateKeyPairSync('ed25519')
  const identity = {
    profileId: randomUUID(),
    installationId: randomUUID(),
    publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  }
  const owners: { close(): Promise<void> }[] = []
  const files = (native = true) =>
    ProjectOperationMemoryDatabaseFiles.posix({
      ...identity,
      root: join(root, native ? 'native' : 'legacy'),
      ...(native ? { storePurpose: 'native_source_export' as const } : {}),
      legacyRoots: [],
      uid: process.getuid!(),
      pid: process.pid,
      processNonce: randomUUID(),
    })
  const open = async () => {
    const db = await ProjectOperationMemoryNativeDatabase.open(await files())
    owners.push(db)
    return db
  }
  const fingerprint = (name = 'native') =>
    Object.fromEntries(
      readdirSync(join(root, name), { recursive: true, encoding: 'utf8' })
        .filter(p => lstatSync(join(root, name, p)).isFile())
        .sort()
        .map(p => [
          p,
          createHash('sha256')
            .update(readFileSync(join(root, name, p)))
            .digest('hex'),
        ]),
    )
  onTestFinished(async () => {
    for (const owner of owners.toReversed()) await owner.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, identity, files, open, fingerprint, owners }
}
describe.skipIf(process.platform === 'win32')('native source format isolation', () => {
  it('retains an actual old writer source-v1 file and its reservations byte-for-byte', async () => {
    const f = await fixture(),
      old = await ProjectOperationMemoryDatabase.open(await f.files(false))
    f.owners.push(old)
    old.put('plan', 'original', { sourceAuthorityVersion: '1' }, { rows: 1, bytes: 1000 }, () => {})
    await old.close()
    const before = f.fingerprint('legacy'),
      native = await f.open()
    native.put('cut', 'original', { syntheticMetadata: true }, { rows: 1, bytes: 1000 }, () => {})
    await native.close()
    expect(f.fingerprint('legacy')).toEqual(before)
    const reopened = await f.open()
    expect(reopened.get('cut', 'original')).toEqual({ syntheticMetadata: true })
  })
  it('refuses unknown complete catalog without changing original main/WAL/SHM/bootstrap bytes', async () => {
    const f = await fixture(),
      owner = await f.open()
    await owner.close()
    const raw = new DatabaseSync(join(f.root, 'native', 'memory.v1.sqlite'))
    raw.exec('PRAGMA journal_mode=WAL; CREATE TABLE unknown_source(id INTEGER)')
    // Keep the actual WAL/SHM live so refusal must inspect a private copy, never source SQLite.
    const before = f.fingerprint()
    await expect(f.open()).rejects.toThrow()
    expect(f.fingerprint()).toEqual(before)
    raw.close()
  })
  it.each(['-wal', '-shm', '-journal'])(
    'pending zero-byte main refuses unknown nonempty %s without changing any original file',
    async (suffix) => {
      const f = await fixture(), pending = await f.files()
      pending.releaseSidecars()
      await pending.releaseAfterDatabaseClose()
      const path = join(f.root, 'native', 'memory.v1.sqlite')
      expect(readFileSync(path)).toHaveLength(0)
      writeFileSync(path + suffix, Buffer.from('unknown non-empty source companion'), { mode: 0o600 })
      const before = f.fingerprint()
      await expect(f.open()).rejects.toThrow()
      expect(f.fingerprint()).toEqual(before)
    },
  )
  it('known source with actual uncheckpointed WAL reopens without altering committed metadata', async () => {
    const f = await fixture(), owner = await f.open()
    owner.put('cut', 'retained', { exact: 'original' }, { rows: 1, bytes: 1000 }, () => {})
    await owner.close()
    const raw = new DatabaseSync(join(f.root, 'native', 'memory.v1.sqlite'))
    try {
      raw.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE transient_bootstrap_probe(id INTEGER); DROP TABLE transient_bootstrap_probe')
      expect(readFileSync(join(f.root, 'native', 'memory.v1.sqlite-wal')).length).toBeGreaterThan(0)
      const reopened = await f.open()
      expect(reopened.get('cut', 'retained')).toEqual({ exact: 'original' })
      await reopened.close()
    } finally {
      raw.close()
    }
  })
  it('wrong purpose cannot open a native file as a released source format', async () => {
    const f = await fixture(),
      native = await f.open()
    await native.close()
    const before = f.fingerprint()
    await expect(
      (async () =>
        ProjectOperationMemoryDatabase.open(
          await ProjectOperationMemoryDatabaseFiles.posix({
            ...f.identity,
            root: join(f.root, 'native'),
            legacyRoots: [],
            uid: process.getuid!(),
            pid: process.pid,
            processNonce: randomUUID(),
          }),
        ))(),
    ).rejects.toThrow()
    expect(f.fingerprint()).toEqual(before)
  })
})
