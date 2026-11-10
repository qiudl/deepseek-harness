import { runtimeEntryTestCode } from '../../../api/session-controller/tests/runtime-entry-test-code.ts'
/** Real SQLite writer and DSBot mixed allocator; the generated Cloud key is a component fixture, never a production claim. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeEntryFactory } from '../../../api/session-controller/src/runtime-entry.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RuntimeEntryJournal } from '../../../api/session-controller/src/runtime-entry-journal.ts'
import { parseRuntimeEntryBinding, parseRuntimeEntryObservation, parseRuntimeEntryAttribution,
  encodeRuntimeEntryAttribution, runtimeEntryObservationDigest, runtimeEntryReceiptDigest,
  type RuntimeEntryObservation } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProjectOperationRuntimeEntryCandidate, ProjectOperationRuntimeEntryPublication } from '@deepseek-ai/dsh-api-session-controller'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AccountRuntimeEntryOrigin, type AccountRuntimeEntryOriginOptions } from '../src/account-runtime-entry-origin.ts'

const dsbotRoot = process.env.REQ0006_DSBOT_SOURCE_ROOT
const digest = '1'.repeat(64)
const fixture = JSON.parse(readFileSync(new URL('../../../host/control-protocol/tests/fixtures/project-operation-runtime-entry-v1.json',
  import.meta.url), 'utf8')) as { values: { binding: unknown; observation: RuntimeEntryObservation } }
interface SourceJournal {
  appendRuntimeEntryCandidate(candidate: ProjectOperationRuntimeEntryCandidate): { mapping: { sourceEventId: string } }
  publishRuntimeEntry(input: { entryId: string; publication: ProjectOperationRuntimeEntryPublication }): unknown
  close(): void
}
async function harness(grantDuration = 60000, actualDriver = false) {
  if (!dsbotRoot) throw Error('REQ0006_DSBOT_SOURCE_ROOT required for actual DSBot source bench')
  const source = await import(/* @vite-ignore */ pathToFileURL(join(dsbotRoot, 'src/host/project-operation-journal.js')).href) as {
    openProjectOperationJournal(path: string): Promise<SourceJournal>
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'entry-publication-main-'))), pluginHome = join(directory, 'bot')
  const journalPath = join(directory, 'entry.sqlite'), journal = new RuntimeEntryJournal(journalPath)
  const sourceJournal = await source.openProjectOperationJournal(join(pluginHome, 'project-operations.sqlite'))
  onTestFinished(() => { sourceJournal.close(); journal.close(); rmSync(directory, { recursive: true, force: true }) })
  const now = Date.now(), parsed = parseRuntimeEntryBinding(fixture.values.binding)
  const binding = parseRuntimeEntryBinding({ ...parsed, grantIssuedAt: now - 1000, grantExpiresAt: now + grantDuration })
  const write = { binding, implementationDigest: digest, compositionDigest: digest,
    queueOccurrenceId: '00000001-1111-4111-8111-000000000001', queueGeneration: '1',
    driverReservationId: '00000002-1111-4111-8111-000000000002', workerLifetimeId: '00000003-1111-4111-8111-000000000003',
    sessionInstanceGeneration: '1', sessionBirthReceiptDigest: digest,
    manifestInputs: { originalAuthorityDigest: digest, accountAuthorityDigest: digest, sessionAuthorityDigest: digest,
      compositionAuthorityDigest: digest, registryGeneration: '1' } }
  let witness
  if (actualDriver) {
    const ctx = new Context()
    onTestFinished(async () => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('actual driver continued')]))
    const agent = await ctx.agentLoop.create(SessionId(binding.sessionId), { provider: 'mock', model: 'mock' })
    const code = runtimeEntryTestCode(directory)
    const factory = new RuntimeEntryFactory({ assertCurrentCode: () => { code.assertCurrentCode() }, journal,
      workerLifetimeId: write.workerLifetimeId, implementationDigest: digest,
      compositionDigest: digest, compositionAuthorityDigest: digest, registryGeneration: '1',
      readOriginalMetadata: async () => ({ binding, dispatchGranted: true, sourceKind: 'primary_human',
        taskRef: brandString<NonNullable<ProjectOperationRuntimeEntryCandidate['taskRef']>>('actual-original-task'),
        projectId: brandString<ProjectOperationRuntimeEntryCandidate['projectId']>('original-admission-project'),
        originalAuthorityDigest: digest, accountAuthorityDigest: digest, isCurrent: () => true }),
      readLoadedSession: async () => ({ session: agent.session, birthReceiptDigest: digest, instanceGeneration: '1',
        sessionAuthorityDigest: digest, logOffset: agent.session.seq, surfaceGeneration: agent.session.surface.contentGeneration,
        isCurrent: () => true }), isCurrentComposition: actual => actual === agent })
    onTestFinished(() => { factory.close() })
    const prepared = await factory.prepare(agent, binding.consumerCommandId, new AbortController().signal)
    if (prepared.kind !== 'prepared') throw Error('actual driver unavailable')
    const entered = await prepared.start(async () => {
      expect(journal.count()).toBe(1)
      return createUserMessage({ content: [{ type: 'text', text: 'original feedback' }], source: { kind: 'user' } })
    })
    if (entered.kind !== 'entered') throw Error('actual driver entry failed')
    witness = entered.witness
  } else witness = journal.commitOriginalInvocationEntry(write, () => true)
  let current = true, taskRef = brandString<NonNullable<ProjectOperationRuntimeEntryCandidate['taskRef']>>('actual-original-task'), cloudCalls = 0
  const candidate: ProjectOperationRuntimeEntryCandidate = { profileId: brandString<ProjectOperationRuntimeEntryCandidate['profileId']>(binding.hostProfileId),
    botRootId: brandString<ProjectOperationRuntimeEntryCandidate['botRootId']>(binding.botId),
    sessionId: brandString<ProjectOperationRuntimeEntryCandidate['sessionId']>(binding.sessionId), ownerUserId: brandString<ProjectOperationRuntimeEntryCandidate['ownerUserId']>(binding.ownerUserId),
    projectId: brandString<ProjectOperationRuntimeEntryCandidate['projectId']>('original-admission-project'), taskRef, invocationRef: brandString<ProjectOperationRuntimeEntryCandidate['invocationRef']>(binding.invocationId),
    entryId: brandString<ProjectOperationRuntimeEntryCandidate['entryId']>(witness.receipt.entryId), entryEffectAt: witness.receipt.entryEffectAt,
    entryReceiptDigest: runtimeEntryReceiptDigest(witness.receipt), manifestDigest: witness.receipt.manifestDigest }
  sourceJournal.appendRuntimeEntryCandidate(candidate)
  const hostKeys = generateKeyPairSync('ed25519'), cloudKeys = generateKeyPairSync('ed25519')
  const publicKey = hostKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const o = fixture.values.observation
  const options: AccountRuntimeEntryOriginOptions = { profileRoot: directory, pluginHome, entryJournalPath: journalPath,
    implementationDigest: digest, compositionDigest: digest,
    artifactPins: ['project-operation-native-entry.js', 'project-operation-journal.js'].map((name) => {
      const path = join(dsbotRoot, 'src/host', name)
      return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
    }),
    keyrings: [{ version: 1, environmentId: binding.authorityEnvironmentId, issuer: 'https://cloud.fixture.test',
      keys: [{ kid: 'fixture-cloud', publicKeyPem: cloudKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        validFrom: now - 60000, validUntil: now + 600000 }] }],
    captureCurrentLease: () => ({ issuer: 'dsh-host', keyId: 'fixture-installation',
      account: { authorityEnvironmentId: binding.authorityEnvironmentId, accountIssuer: o.accountIssuer, accountSubject: o.accountSubject,
        accountBindingId: o.accountBindingId, accountBindingVersion: 1, hostProfileId: binding.hostProfileId },
      peer: { ...o.peer, publicKey }, assertCurrent: () => { if (!current) throw Error('actual_worker_replaced') } }),
    readOriginalMetadata: async () => ({ binding, taskRef, projectId: candidate.projectId, dispatchGranted: true,
      sourceKind: 'primary_human', originalAuthorityDigest: digest, accountAuthorityDigest: digest, isCurrent: () => current }),
    sign: bytes => sign(null, bytes, hostKeys.privateKey).toString('base64url'),
    registerObservation: async (raw) => {
      cloudCalls++
      const observation = parseRuntimeEntryObservation(raw), mapping = observation.sourceEventMapping
      if (!mapping) throw Error('actual mapping missing')
      const claim = parseRuntimeEntryAttribution({ schemaVersion: 1, purpose: 'project_operation_runtime_entry_attribution',
        issuer: 'https://cloud.fixture.test', keyId: 'fixture-cloud', authorityEnvironmentId: binding.authorityEnvironmentId,
        accountIssuer: observation.accountIssuer, accountSubject: observation.accountSubject,
        accountBindingId: observation.accountBindingId, accountBindingVersion: observation.accountBindingVersion,
        hostProfileId: binding.hostProfileId, botId: binding.botId, installationId: observation.peer.installationId,
        publicKey: observation.peer.publicKey, requestId: observation.requestId, issuedAt: Date.now(), expiresAt: Date.now() + 120000,
        observationDigest: runtimeEntryObservationDigest(observation), entryReceiptDigest: candidate.entryReceiptDigest,
        manifestDigest: candidate.manifestDigest, binding, entryId: candidate.entryId, projectId: candidate.projectId,
        sourceEventId: mapping.sourceEventId, sourceRevision: mapping.sourceRevision, payloadDigest: mapping.payloadDigest,
        signature: 'A'.repeat(86) })
      return { observation, attribution: { ...claim, signature: sign(null, Buffer.from(encodeRuntimeEntryAttribution(claim)),
        cloudKeys.privateKey).toString('base64url') } }
    } }
  const request = { originalCommandId: binding.consumerCommandId, entryId: candidate.entryId,
    sourceEventId: 'dsh-runtime-entry:' + candidate.entryId, sourceRevision: '1' }
  return { options, request, candidate, directory, pluginHome, sourceJournal, journal, signal: new AbortController().signal,
    cloudCalls: () => cloudCalls, revoke: () => { current = false }, wrongTask: () => { taskRef = brandString<NonNullable<ProjectOperationRuntimeEntryCandidate['taskRef']>>('different-task') } }
}
function directoryState(directory: string) {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name), stat = lstatSync(path)
    return { name, mode: stat.mode, uid: stat.uid, nlink: stat.nlink, size: stat.size, ino: stat.ino, dev: stat.dev,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: createHash('sha256').update(readFileSync(path)).digest('hex') }
  })
}
function copySource(h: Awaited<ReturnType<typeof harness>>) {
  const home = join(h.directory, 'source-copy')
  mkdirSync(home, { mode: 0o700 })
  for (const suffix of ['', '-wal', '-shm']) copyFileSync(join(h.pluginHome, 'project-operations.sqlite' + suffix),
    join(home, 'project-operations.sqlite' + suffix))
  return home
}
function trackSnapshots() {
  const created: string[] = [], create = fs.mkdtempSync.bind(fs)
  const spy = vi.spyOn(fs, 'mkdtempSync').mockImplementation((...args: Parameters<typeof fs.mkdtempSync>) => {
    const path = create(...args)
    if (typeof path === 'string' && path.includes('dsh-runtime-entry-read-')) created.push(path)
    return path
  })
  syncBuiltinESMExports()
  onTestFinished(() => { spy.mockRestore(); syncBuiltinESMExports() })
  return created
}
describe('Main runtime entry publication', () => {
  it('requires bootstrap artifact pins before reading or signing', () => {
    expect(() => new AccountRuntimeEntryOrigin({ artifactPins: [] } as never)).toThrow('runtime_entry_publication_unavailable')
  })
})
describe.skipIf(!dsbotRoot)('actual DSBot independent mapping readback (controlled Cloud signer)', () => {
  it('reads the real mixed allocator mapping independently, then permits historical observation only after source publication', async () => {
    const h = await harness(), main = new AccountRuntimeEntryOrigin(h.options)
    await expect(main.observe(h.candidate.entryId, h.signal)).rejects.toThrow('unavailable')
    const publication = await main.bind(h.request, h.signal)
    expect(Object.keys(publication)).toHaveLength(10)
    expect(publication.projectId).toBe('original-admission-project')
    expect(h.cloudCalls()).toBe(1)
    h.sourceJournal.publishRuntimeEntry({ entryId: h.candidate.entryId, publication })
    const observed = await main.observe(h.candidate.entryId, h.signal)
    expect(observed.receipt.journalId).not.toBe(observed.sourceEventMapping?.journalId)
    expect(observed.sourceEventMapping?.providerId).toBe('dsh-project-operation-v1')
    expect(h.journal.count()).toBe(1)
  })
  it('reads the actual Agent driver receipt through the real DSBot allocator and independent Main SQLite path', async () => {
    const h = await harness(60000, true), main = new AccountRuntimeEntryOrigin(h.options)
    const publication = await main.bind(h.request, h.signal)
    h.sourceJournal.publishRuntimeEntry({ entryId: h.candidate.entryId, publication })
    const observed = await main.observe(h.candidate.entryId, h.signal)
    expect(observed.receipt.entryId).toBe(h.candidate.entryId)
    expect(observed.sourceEventMapping?.entryReceiptDigest).toBe(publication.entryReceiptDigest)
    expect(h.journal.count()).toBe(1)
  })
  it('recovers a lost Cloud reply with the same original signed pair and immutable publication bytes', async () => {
    const h = await harness(), register = h.options.registerObservation.bind(h.options)
    let stored: unknown, calls = 0
    const seenRequests: string[] = []
    const main = new AccountRuntimeEntryOrigin({ ...h.options, registerObservation: async (o, signal) => {
      seenRequests.push(o.requestId)
      if (stored === undefined) stored = await register(o, signal)
      if (++calls === 1) throw Error('cloud_reply_lost_after_original_commit')
      return stored
    } })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('cloud_reply_lost')
    const first = await main.bind(h.request, h.signal)
    const second = await main.bind(h.request, h.signal)
    expect(seenRequests).toHaveLength(3)
    expect(new Set(seenRequests).size).toBe(3)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(h.cloudCalls()).toBe(1)
    expect(h.journal.count()).toBe(1)
    h.sourceJournal.publishRuntimeEntry({ entryId: h.candidate.entryId, publication: first })
  })
  it('retains an expired original proof as history after fresh Cloud authorization without renewing its bytes', async () => {
    const h = await harness(300000), register = h.options.registerObservation.bind(h.options)
    let stored: unknown
    const main = new AccountRuntimeEntryOrigin({ ...h.options, registerObservation: async (o, signal) => {
      if (stored === undefined) stored = await register(o, signal)
      return stored
    } })
    const first = await main.bind(h.request, h.signal), later = Date.now() + 121000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    onTestFinished(() => { clock.mockRestore() })
    const second = await main.bind(h.request, h.signal)
    expect(second).toEqual(first)
    const pair = stored as { attribution: unknown }
    expect(parseRuntimeEntryAttribution(pair.attribution).expiresAt).toBeLessThan(later)
    expect(h.cloudCalls()).toBe(1)
    expect(h.journal.count()).toBe(1)
  })
  it.each(['unknown_schema', 'unknown_schema_empty_shm', 'empty_shm', 'malformed_wal'] as const)(
    'rejects %s while preserving every original file and cleaning private snapshots', async (mode) => {
      const h = await harness()
      if (mode.startsWith('unknown_schema')) {
        const writer = new DatabaseSync(join(h.pluginHome, 'project-operations.sqlite'))
        writer.exec('CREATE TABLE unsupported_schema(secret TEXT)'); writer.close()
      }
      const home = copySource(h)
      if (mode.includes('empty_shm')) writeFileSync(join(home, 'project-operations.sqlite-shm'), Buffer.alloc(0))
      if (mode === 'malformed_wal') writeFileSync(join(home, 'project-operations.sqlite-wal'), Buffer.from('invalid WAL bytes'))
      const before = directoryState(home), snapshots = trackSnapshots()
      const main = new AccountRuntimeEntryOrigin({ ...h.options, pluginHome: home })
      await expect(main.bind(h.request, h.signal)).rejects.toThrow()
      expect(directoryState(home)).toEqual(before)
      expect(h.cloudCalls()).toBe(0)
      expect(snapshots.every(path => !existsSync(path))).toBe(true)
    })
  it('rejects a malformed WAL even when checkpointed main already contains the candidate', async () => {
    const h = await harness(), writer = new DatabaseSync(join(h.pluginHome, 'project-operations.sqlite'))
    writer.exec('PRAGMA wal_checkpoint(FULL)'); writer.close()
    const home = copySource(h)
    writeFileSync(join(home, 'project-operations.sqlite-wal'), Buffer.from('invalid WAL bytes'))
    const before = directoryState(home), main = new AccountRuntimeEntryOrigin({ ...h.options, pluginHome: home })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow()
    expect(directoryState(home)).toEqual(before)
    expect(h.cloudCalls()).toBe(0)
  })
  it('reads an uncheckpointed live DSBot WAL without changing its files or retaining snapshots', async () => {
    const h = await harness(), before = directoryState(h.pluginHome), snapshots = trackSnapshots()
    expect(lstatSync(join(h.pluginHome, 'project-operations.sqlite-wal')).size).toBeGreaterThan(0)
    const main = new AccountRuntimeEntryOrigin(h.options)
    const publication = await main.bind(h.request, h.signal)
    expect(publication.entryId).toBe(h.candidate.entryId)
    expect(directoryState(h.pluginHome)).toEqual(before)
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.every(path => !existsSync(path))).toBe(true)
  })
  it('rejects a source generation change across Cloud await without adding reader writes', async () => {
    const h = await harness(), register = h.options.registerObservation.bind(h.options)
    let changed: ReturnType<typeof directoryState> | undefined
    const main = new AccountRuntimeEntryOrigin({ ...h.options, registerObservation: async (o, signal) => {
      const output = await register(o, signal)
      const writer = new DatabaseSync(join(h.pluginHome, 'project-operations.sqlite'))
      writer.exec('UPDATE journal_meta SET last_sequence=last_sequence+1 WHERE id=1'); writer.close()
      changed = directoryState(h.pluginHome)
      return output
    } })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(directoryState(h.pluginHome)).toEqual(changed)
    expect(h.journal.count()).toBe(1)
  })
  it('rejects mutation while source descriptors are copied and cleans every partial snapshot', async () => {
    const h = await harness(), snapshots = trackSnapshots(), write = fs.writeFileSync.bind(fs)
    let changed: ReturnType<typeof directoryState> | undefined
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args)
      if (changed === undefined && typeof args[0] === 'string' && args[0].includes('dsh-runtime-entry-read-')) {
        const writer = new DatabaseSync(join(h.pluginHome, 'project-operations.sqlite'))
        writer.exec('UPDATE journal_meta SET last_sequence=last_sequence+1 WHERE id=1'); writer.close()
        changed = directoryState(h.pluginHome)
      }
    })
    syncBuiltinESMExports()
    onTestFinished(() => { spy.mockRestore(); syncBuiltinESMExports() })
    const main = new AccountRuntimeEntryOrigin(h.options)
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(changed).toBeDefined()
    expect(directoryState(h.pluginHome)).toEqual(changed)
    expect(h.cloudCalls()).toBe(0)
    expect(snapshots.every(path => !existsSync(path))).toBe(true)
  })
  it('rejects changed original task metadata before any Cloud request', async () => {
    const h = await harness(), main = new AccountRuntimeEntryOrigin(h.options)
    h.wrongTask()
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.cloudCalls()).toBe(0)
  })
  it('rejects current worker replacement across Cloud await without a publication', async () => {
    const h = await harness(), register = h.options.registerObservation.bind(h.options)
    const main = new AccountRuntimeEntryOrigin({ ...h.options, registerObservation: async (o, signal) => {
      const output = await register(o, signal); h.revoke(); return output
    } })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('actual_worker_replaced')
    expect(h.journal.count()).toBe(1)
  })
  it('rejects an altered schema and writes no Cloud claim', async () => {
    const h = await harness(), path = join(h.pluginHome, 'project-operations.sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE alien(value TEXT)'); db.close()
    const main = new AccountRuntimeEntryOrigin(h.options)
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.cloudCalls()).toBe(0)
  })
  it('rejects a substituted database purpose before signing', async () => {
    const h = await harness(), path = join(h.pluginHome, 'project-operations.sqlite')
    const db = new DatabaseSync(path); db.exec('PRAGMA application_id=1234'); db.close()
    const main = new AccountRuntimeEntryOrigin(h.options)
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.cloudCalls()).toBe(0)
  })
  it('rejects an unsafe WAL sidecar before signing or Cloud access', async () => {
    const h = await harness(), wal = join(h.pluginHome, 'project-operations.sqlite-wal')
    chmodSync(wal, 0o644)
    const main = new AccountRuntimeEntryOrigin(h.options)
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.cloudCalls()).toBe(0)
  })
  it('rejects an Account from another environment before signing or calling Cloud', async () => {
    const h = await harness(), capture = h.options.captureCurrentLease.bind(h.options)
    const main = new AccountRuntimeEntryOrigin({ ...h.options, captureCurrentLease: () => {
      const lease = capture()
      return { ...lease, account: { ...lease.account, authorityEnvironmentId: '20000000-0000-4000-8000-000000000001' } }
    } })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.cloudCalls()).toBe(0)
  })
  it('rejects a changed complete Event even when its mapping fields remain unchanged', async () => {
    const h = await harness(), path = join(h.pluginHome, 'project-operations.sqlite')
    const db = new DatabaseSync(path)
    db.prepare("UPDATE runtime_entry_candidates SET event_json=json_set(event_json,'$.taskRef','forged-task') WHERE entry_id=?")
      .run(h.candidate.entryId)
    db.close()
    const main = new AccountRuntimeEntryOrigin(h.options)
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.cloudCalls()).toBe(0)
  })
  it('rejects original authority metadata mismatches before source publication', async () => {
    const h = await harness(), read = h.options.readOriginalMetadata.bind(h.options)
    const main = new AccountRuntimeEntryOrigin({ ...h.options, readOriginalMetadata: async (command, signal) => {
      const original = await read(command, signal)
      return original === undefined ? undefined : { ...original, originalAuthorityDigest: '2'.repeat(64) }
    } })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.cloudCalls()).toBe(0)
  })
  it('rejects cancellation across Cloud await while keeping original history', async () => {
    const h = await harness(), abort = new AbortController(), register = h.options.registerObservation.bind(h.options)
    const main = new AccountRuntimeEntryOrigin({ ...h.options, registerObservation: async (o, signal) => {
      const output = await register(o, signal); abort.abort(); return output
    } })
    await expect(main.bind(h.request, abort.signal)).rejects.toThrow()
    expect(h.journal.count()).toBe(1)
  })
  it('denies publication after original grant expiry during Cloud await', async () => {
    const h = await harness(), register = h.options.registerObservation.bind(h.options)
    const main = new AccountRuntimeEntryOrigin({ ...h.options, registerObservation: async (o, signal) => {
      const output = await register(o, signal)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(o.receipt.binding.grantExpiresAt)
      onTestFinished(() => { clock.mockRestore() })
      return output
    } })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
    expect(h.journal.count()).toBe(1)
  })
  it('rejects Cloud attribution signed by a different key', async () => {
    const h = await harness(), register = h.options.registerObservation.bind(h.options)
    const main = new AccountRuntimeEntryOrigin({ ...h.options, registerObservation: async (o, signal) => {
      const pair = await register(o, signal) as { observation: RuntimeEntryObservation; attribution: unknown }
      const claim = parseRuntimeEntryAttribution(pair.attribution)
      const alien = generateKeyPairSync('ed25519')
      return { observation: pair.observation, attribution: { ...claim,
        signature: sign(null, Buffer.from(encodeRuntimeEntryAttribution(claim)), alien.privateKey).toString('base64url') } }
    } })
    await expect(main.bind(h.request, h.signal)).rejects.toThrow('unavailable')
  })
  it('rejects actual artifact replacement before any private reads', async () => {
    const h = await harness(), alien = join(h.directory, 'project-operation-native-entry.js')
    writeFileSync(alien, 'changed implementation', { mode: 0o600 })
    expect(() => new AccountRuntimeEntryOrigin({ ...h.options,
      artifactPins: h.options.artifactPins.map(p => p.path.endsWith('/project-operation-native-entry.js') ? { ...p, path: alien } : p) }))
      .toThrow('unavailable')
  })
})

describe.skipIf(!dsbotRoot)('unary original candidate reconciliation (controlled Cloud signer)', () => {
  it('observes the real candidate, accepts only its stored signed pair, and leaves publication to the actual consumer', async () => {
    const h = await harness(), main = new AccountRuntimeEntryOrigin(h.options)
    const original = h.journal.read(h.candidate.entryId)
    const observation = await main.observeCandidate(h.candidate.entryId, h.signal)
    expect(observation.sourceEventMapping?.sourceEventId).toBe(h.request.sourceEventId)
    expect(h.cloudCalls()).toBe(0)
    await expect(main.observe(h.candidate.entryId, h.signal)).rejects.toThrow('unavailable')
    const pair = await h.options.registerObservation(observation, h.signal)
    const publication = await main.bindPair(h.candidate.entryId, pair, h.signal)
    expect(h.cloudCalls()).toBe(1)
    expect(publication.entryReceiptDigest).toBe(h.candidate.entryReceiptDigest)
    expect(h.journal.read(h.candidate.entryId)).toEqual(original)
    await expect(main.observe(h.candidate.entryId, h.signal)).rejects.toThrow('unavailable')
    h.sourceJournal.publishRuntimeEntry({ entryId: h.candidate.entryId, publication })
    await expect(main.observe(h.candidate.entryId, h.signal)).resolves.toMatchObject({ receipt: original?.receipt })
    await expect(main.bindPair(h.candidate.entryId, { observation, attribution: {} }, h.signal)).rejects.toThrow()
    h.revoke()
    await expect(main.bindPair(h.candidate.entryId, pair, h.signal)).rejects.toThrow('replaced')
  })
})
