/** Runtime-entry's unpublished DELETE-only format rejects foreign/WAL files before any SQLite open. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RuntimeEntryJournal, readRuntimeEntryWitness } from '../src/runtime-entry-journal.ts'

const entryId = '00000000-0000-4000-8000-000000000013'
function fixture(mode: 'DELETE' | 'WAL', own: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-entry-format-'))
  chmodSync(dir, 0o700)
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const path = join(dir, 'entry.sqlite')
  if (own) { const journal = new RuntimeEntryJournal(path); journal.close() }
  const sql = own ? `PRAGMA journal_mode=${mode}; CREATE TABLE unexpected(id TEXT);`
    : `PRAGMA journal_mode=${mode}; PRAGMA synchronous=FULL; PRAGMA application_id=123; PRAGMA user_version=7; CREATE TABLE original(value TEXT); INSERT INTO original VALUES('synthetic original data');`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { DatabaseSync } from 'node:sqlite'; import { chmodSync } from 'node:fs';
     const db = new DatabaseSync(${JSON.stringify(path)}); db.exec(${JSON.stringify(sql)}); chmodSync(${JSON.stringify(path)},0o600);
     ${mode === 'WAL' ? "process.kill(process.pid,'SIGKILL')" : 'db.close()'}`],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
  if (mode === 'WAL') expect(result.signal).toBe('SIGKILL')
  else expect(result.status, result.stderr).toBe(0)
  return { dir, path }
}
function snapshot(dir: string) {
  return readdirSync(dir).sort().map((name) => {
    const path = join(dir, name), stat = statSync(path)
    return { name, bytes: stat.size, mode: stat.mode, hash: createHash('sha256').update(readFileSync(path)).digest('hex') }
  })
}
describe('runtime-entry zero-write format rejection', () => {
  for (const target of ['writer', 'reader'] as const) for (const mode of ['DELETE', 'WAL'] as const) for (const own of [false, true])
    it(`${target} preserves ${own ? 'unknown own-purpose catalog' : 'foreign purpose'} ${mode} files`, () => {
      const f = fixture(mode, own), before = snapshot(f.dir)
      expect(() => {
        if (target === 'reader') readRuntimeEntryWitness(f.path, entryId)
        else { const journal = new RuntimeEntryJournal(f.path); journal.close() }
      }).toThrow()
      expect(snapshot(f.dir)).toEqual(before)
    })
  for (const target of ['writer', 'reader'] as const)
    it(`${target} never manufactures missing SHM for a foreign WAL database`, () => {
      const f = fixture('WAL', false)
      unlinkSync(f.path + '-shm')
      const before = snapshot(f.dir)
      expect(() => {
        if (target === 'reader') readRuntimeEntryWitness(f.path, entryId)
        else { const journal = new RuntimeEntryJournal(f.path); journal.close() }
      }).toThrow()
      expect(snapshot(f.dir)).toEqual(before)
    })
  it('reopens the actual DELETE journal and reads an absent entry without changing its files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-entry-format-positive-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    const path = join(dir, 'entry.sqlite'), first = new RuntimeEntryJournal(path)
    first.close()
    const before = snapshot(dir), reopened = new RuntimeEntryJournal(path)
    expect(reopened.count()).toBe(0)
    expect(reopened.read(entryId)).toBeUndefined()
    reopened.close()
    expect(snapshot(dir)).toEqual(before)
  })
})
