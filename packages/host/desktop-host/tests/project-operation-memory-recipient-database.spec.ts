import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
/** Actual private SQLite format isolation and two-owner lifecycle; physical Windows acceptance remains separate. */
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ProjectOperationMemoryDatabase } from '../src/project-operation-memory-database.ts'
import { ProjectOperationMemoryRecipientDatabase } from '../src/project-operation-memory-recipient-database.ts'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'
import { TwinBindingReceipts } from '../src/twin-binding-receipts.ts'
import { createPosixTwinBindingReceiptFile } from '../src/twin-binding-receipt-files.ts'
import { ProjectOperationMemoryDatabases } from '../src/project-operation-memory-databases.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'req0006-recipient-format-')), key = generateKeyPairSync('ed25519')
  const identity = { profileId: randomUUID(), installationId: randomUUID(), publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url') }
  const owners: { close(): Promise<void> }[] = []
  const files = (role: 'source' | 'recipient', purpose = role) => ProjectOperationMemoryDatabaseFiles.posix({ ...identity, root: join(root, role), ...(purpose === 'recipient' ? { storePurpose: 'recipient_import' as const } : {}), legacyRoots: [], uid: process.getuid!(), pid: process.pid, processNonce: randomUUID() })
  const source = async () => { const db = await ProjectOperationMemoryDatabase.open(await files('source')); owners.push(db); return db }
  const recipient = async () => { const db = await ProjectOperationMemoryRecipientDatabase.open(await files('recipient')); owners.push(db); return db }
  onTestFinished(async () => {
    for (const owner of owners.toReversed()) await owner.close()
    rmSync(root, { recursive: true, force: true })
  })
  const fingerprint = (role: string) => Object.fromEntries(readdirSync(join(root, role), { recursive: true, encoding: 'utf8' }).filter(name => lstatSync(join(root, role, name)).isFile()).sort().map((name): readonly [string, string] => [name, createHash('sha256').update(readFileSync(join(root, role, name))).digest('hex')]))
  return { root, identity, files, source, recipient, fingerprint }
}
describe.skipIf(process.platform === 'win32')('POSIX recipient format and ownership isolation', () => {
  it('keeps populated sealed source-v1 bytes, counters, IDs and reservations unchanged when recipient opens and commits', async () => {
    const f = await fixture(), source = await f.source()
    for (const kind of ['confirmation', 'plan', 'delivery', 'frontier'] as const)
      source.put(kind, kind, { original: kind }, { rows: 1, bytes: 1000 }, () => {})
    source.put('nonce', 'original-nonce', { original: 'nonce' }, { rows: 1, bytes: 1000, expiresAt: 5000 }, () => {})
    source.put('published', 'original-page', { original: 'published' }, { rows: 1, bytes: 1000, expiresAt: 5000 }, () => {})
    const budget = source.usage()
    await source.close()
    const sealed = f.fingerprint('source'), recipient = await f.recipient()
    recipient.put('reference', 'same-original-id', { isolated: true }, { rows: 1, bytes: 1000 }, () => {})
    await recipient.close()
    expect(f.fingerprint('source')).toEqual(sealed)
    const reopened = await f.source()
    expect(reopened.usage()).toEqual(budget)
    expect(reopened.get('delivery', 'delivery')).toEqual({ original: 'delivery' })
    expect(reopened.get('reference' as 'delivery', 'same-original-id')).toBeNull()
    await reopened.close()
    expect(f.fingerprint('source')).toEqual(sealed)
  })
  it.each(['source-app','future-version','signature','short-header','pending-source-app','pending-future-version'] as const)(
    'rejects %s before creating any sidecar and preserves the complete original directory', async (fault) => {
      const f = await fixture(), recipient = await f.recipient()
      await recipient.close()
      const path = join(f.root, 'recipient', 'memory.v1.sqlite'), bytes = readFileSync(path)
      if (fault === 'source-app' || fault === 'pending-source-app') bytes.writeUInt32BE(0x44534d31, 68)
      else if (fault === 'future-version') bytes.writeUInt32BE(2, 60)
      else if (fault === 'pending-future-version') { bytes.writeUInt32BE(0, 68); bytes.writeUInt32BE(2, 60) }
      else if (fault === 'signature') bytes[0] = 0
      writeFileSync(path, fault === 'short-header' ? bytes.subarray(0, 16) : bytes)
      if (fault.startsWith('pending-')) {
        const marker = join(f.root, 'recipient', 'bootstrap', 'receipts.v1.json')
        const value: unknown = JSON.parse(readFileSync(marker, 'utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid fixture marker')
        writeFileSync(marker, JSON.stringify({ ...value, state: 'pending' }))
      }
      const before = f.fingerprint('recipient')
      expect(Object.keys(before)).not.toContain('memory.v1.sqlite-wal')
      expect(Object.keys(before)).not.toContain('memory.v1.sqlite-shm')
      await expect(f.recipient()).rejects.toThrow()
      expect(f.fingerprint('recipient')).toEqual(before)
    })
  it('resumes only an actual unpublished empty SQLite header before its identity transaction', async () => {
    const f = await fixture(), files = await f.files('recipient'), raw = new DatabaseSync(files.path)
    raw.exec('PRAGMA journal_mode=WAL')
    files.releaseSidecars(); raw.close(); await files.releaseAfterDatabaseClose()
    const recipient = await f.recipient()
    expect(recipient.usage().permanent.actual_rows).toBe(0)
    await recipient.close()
  })
  it('refuses cross-opening the two exact formats before any writable SQL and preserves each original file', async () => {
    const f = await fixture(), source = await f.source(), recipient = await f.recipient()
    await source.close(); await recipient.close()
    const beforeSource = f.fingerprint('source'), beforeRecipient = f.fingerprint('recipient')
    await expect((async () => ProjectOperationMemoryRecipientDatabase.open(await f.files('source', 'recipient')))()).rejects.toThrow()
    expect(f.fingerprint('source')).toEqual(beforeSource)
    await expect((async () => ProjectOperationMemoryDatabase.open(await f.files('recipient', 'source')))()).rejects.toThrow()
    expect(f.fingerprint('recipient')).toEqual(beforeRecipient)
    const s = new DatabaseSync(join(f.root, 'source', 'memory.v1.sqlite'), { readOnly: true })
    const r = new DatabaseSync(join(f.root, 'recipient', 'memory.v1.sqlite'), { readOnly: true })
    try {
      expect(s.prepare('PRAGMA application_id').get()?.application_id).toBe(0x44534d31)
      expect(r.prepare('PRAGMA application_id').get()?.application_id).toBe(0x44534d32)
      expect(s.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_records'").get()?.sql).toContain("'confirmation','plan','nonce','published','delivery','frontier'")
      expect(r.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_records'").get()?.sql).toContain("'delivery','reference','nonce'")
    } finally { s.close(); r.close() }
  })
  it('refuses truncated published recipient files and unknown DDL without recreating a historical ledger', async () => {
    const f = await fixture(), db = await f.recipient()
    db.put('reference', 'permanent-id', { original: true }, { rows: 1, bytes: 1000 }, () => {})
    await db.close()
    const path = join(f.root, 'recipient', 'memory.v1.sqlite'), original = readFileSync(path)
    writeFileSync(path, Buffer.alloc(0))
    await expect(f.recipient()).rejects.toThrow()
    expect(readFileSync(path)).toHaveLength(0)
    writeFileSync(path, original)
    const raw = new DatabaseSync(path)
    try { raw.exec('CREATE TABLE unknown_recipient_format(value TEXT) STRICT') } finally { raw.close() }
    const altered = readFileSync(path)
    await expect(f.recipient()).rejects.toThrow()
    expect(readFileSync(path)).toEqual(altered)
  })
  it.each(['source', 'recipient'] as const)('stops both factory sets and attempts both closes when %s SQLite close retains ownership', async (side) => {
    const f = await fixture(), source = await f.source(), recipient = await f.recipient()
    const owners = new ProjectOperationMemoryDatabases(async () => source, async () => recipient)
    const services = owners.services(f.identity, [])
    await owners.get(f.identity.profileId)
    const confirmations = new (await import('../src/twin-binding-receipts.ts')).TwinBindingReceipts({ ...f.identity,
      file: { read: () => undefined, ensureDurable() {}, write() { throw Error('no fixture confirmation write') } } })
    await services.createProjectOperationMemoryRecipientImports(f.identity.profileId, confirmations)
    const failing = side === 'source' ? source : recipient, other = side === 'source' ? recipient : source
    const failed = vi.spyOn(failing, 'close').mockRejectedValueOnce(Error('SQLite still live')), otherClose = vi.spyOn(other, 'close')
    await expect(owners.close()).rejects.toThrow('project_memory_ownership_retained')
    expect(otherClose).toHaveBeenCalledTimes(1)
    await expect(owners.get(randomUUID())).rejects.toThrow()
    await expect(services.createProjectOperationMemoryRecipientImports(randomUUID(), confirmations)).rejects.toThrow()
    await expect(owners.close()).rejects.toThrow('project_memory_ownership_retained')
    failed.mockRestore(); otherClose.mockRestore(); await failing.close()
  })
  it('refuses a mismatched held file capability and an absent recipient factory without changing the main format', async () => {
    const f = await fixture(), recipient = await f.recipient()
    await recipient.close()
    const main = readFileSync(join(f.root, 'recipient', 'memory.v1.sqlite'))
    await expect(ProjectOperationMemoryDatabase.open(await f.files('recipient'))).rejects.toThrow()
    expect(readFileSync(join(f.root, 'recipient', 'memory.v1.sqlite'))).toEqual(main)
    const owners = new ProjectOperationMemoryDatabases(f.source)
    const confirmations = new TwinBindingReceipts({ ...f.identity, file: createPosixTwinBindingReceiptFile(join(f.root, 'confirmations'), process.getuid!()) })
    const services = owners.services(f.identity, [])
    await expect(services.createProjectOperationMemoryRecipientImports(f.identity.profileId, confirmations)).rejects.toThrow()
    await owners.close()
  })

  it.each(['pending-bootstrap','uncommitted-transaction','uncommitted-transaction-missing-shm'] as const)('recovers %s after actual SIGKILL without recreating accepted identities',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'req0006-recipient-kill-')), key = generateKeyPairSync('ed25519')
      const identity = { profileId: randomUUID(), installationId: randomUUID(), publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url') }
      const owned: { database?: ProjectOperationMemoryRecipientDatabase } = {}
      const child = spawn(process.execPath, ['--import','tsx', fileURLToPath(new URL('./fixtures/project-operation-memory-recipient-crash-child.ts', import.meta.url)), JSON.stringify({ ...identity, root }), mode === 'uncommitted-transaction-missing-shm' ? 'uncommitted-transaction' : mode], { stdio: ['ignore','pipe','pipe'] })
      let spawnError: Error | undefined
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('error', (error) => { spawnError = error })
        child.once('close', (code, signal) =>{  resolve({ code, signal }) })
      })
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed
        await owned.database?.close()
        rmSync(root, { recursive: true, force: true })
      })
      let diagnostics = '', output = ''
      child.stderr.on('data', (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-4096) })
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); if (output.includes('private-recipient-ready')) resolve() })
        void closed.then(() =>{  reject(Error('child_closed_before_ready:' + (spawnError?.message ?? diagnostics))) }, reject)
      })
      child.kill('SIGKILL')
      expect(await closed).toEqual({ code: null, signal: 'SIGKILL' })
      if (mode === 'uncommitted-transaction-missing-shm') {
        rmSync(join(root, 'memory.v1.sqlite-shm'))
        const snapshot = () => Object.fromEntries(readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter(name => !name.startsWith('writer/') && lstatSync(join(root, name)).isFile()).sort()
          .map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]))
        const before = snapshot()
        await expect(ProjectOperationMemoryDatabaseFiles.posix({ ...identity, root,
          legacyRoots: [], storePurpose: 'recipient_import', uid: process.getuid!(), pid: process.pid, processNonce: randomUUID() })).rejects.toThrow()
        expect(snapshot()).toEqual(before)
        return
      }
      owned.database = await ProjectOperationMemoryRecipientDatabase.open(
        await ProjectOperationMemoryDatabaseFiles.posix({ ...identity, root,
          legacyRoots: [], storePurpose: 'recipient_import', uid: process.getuid!(), pid: process.pid, processNonce: randomUUID() }))
      expect(owned.database.get('reference','uncommitted-must-rollback')).toBeNull()
      expect(owned.database.get('reference','committed-before-crash')).toEqual(mode === 'pending-bootstrap' ? null : { durable: true })
      expect(owned.database.usage().permanent.actual_rows).toBe(mode === 'pending-bootstrap' ? 0 : 1)
    })

})
