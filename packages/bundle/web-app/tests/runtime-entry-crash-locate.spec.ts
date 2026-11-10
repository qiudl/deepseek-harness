/** REQ-20261031-0006 / Task26733: crash after actual COMMIT/readback, no synthetic receipt or recovery wake.
 * Origin metadata is controlled, not a Cloud authorization positive. 26724 historical settlement is a separate PG gate. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID, generateKeyPairSync } from 'node:crypto'
import { copyFileSync, mkdirSync, writeFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { readRuntimeEntryWitness, readRuntimeEntryWitnessByAttempt, RuntimeEntryJournal } from '../../../api/session-controller/src/runtime-entry-journal.ts'
import { DesktopCollaborationAnalysis, handleDesktopCollaborationAnalysisRequest } from '../src/desktop-collaboration-analysis.ts'
import { parseRuntimeEntryOriginCommand, parseRuntimeEntryMetadataAuthorization } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopRuntimeEntryHost, createDesktopRuntimeEntryLocator } from '../src/desktop-runtime-entry-host.ts'
import { openCrashProfile } from './fixtures/runtime-entry-crash-profile.ts'
type Checkpoint = {
  path: string
  entryId: string
  attemptId: string
  commandId: string
  sequence: string
  time: number
  witnessDigest: string
  profileId: string
  operation: ReturnType<typeof parseRuntimeEntryOriginCommand>
  startedRecordDigest: string
  counters: {
    bodyReads: number
    prepares: number
    driverStarts: number
    metadataReads: number
    modelRequests: number
    consumerStarts: number
    consumerWakes: number
  }
}
type HttpHandlerModule = { handleDesktopCollaborationAnalysisRequest: typeof handleDesktopCollaborationAnalysisRequest }
const worker = fileURLToPath(new URL('./fixtures/runtime-entry-commit-crash-worker.mts', import.meta.url))
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function snapshot(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(name => lstatSync(join(root, name)).isFile())
    .sort().map(name => [name, hash(readFileSync(join(root, name)))]))
}
async function crash() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'req0006-native-crash-locate-'))); chmodSync(root, 0o700)
  const resources: { close?: () => Promise<void> } = {}
  const child = spawn(process.execPath, ['--import', 'tsx', worker, root], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.once('exit', (code, signal) => { resolve({ code, signal }) }))
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += String(data) })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited; await resources.close?.(); rmSync(root, { recursive: true, force: true })
  })
  const checkpoint = await new Promise<Checkpoint>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { reject(Error('actual child checkpoint timed out: ' + stderr)) }, 20000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(Error('child exited before COMMIT/readback: ' + stderr)) })
    child.stdout.on('data', (data) => {
      output += String(data)
      const line = output.split('\n').find(value => value.startsWith('CRASH_READY '))
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('CRASH_READY '.length)) as Checkpoint) }
    })
  })
  expect(checkpoint.counters).toEqual({ bodyReads: 0, prepares: 1, driverStarts: 1, metadataReads: 1,
    consumerStarts: 1, consumerWakes: 1, modelRequests: 0 })
  expect(existsSync(checkpoint.path + '.writer-lock')).toBe(true)
  child.kill('SIGKILL'); expect((await exited).signal).toBe('SIGKILL')
  return { root, checkpoint, resources }
}
describe.skipIf(process.platform === 'win32')('actual committed Native crash recovery boundary', () => {
  it('known entry ID remains independently readable with exact original bytes and the stale wx marker untouched', async () => {
    const f = await crash(), before = snapshot(f.root)
    const witness = readRuntimeEntryWitness(f.checkpoint.path, f.checkpoint.entryId)
    expect(witness?.receipt).toMatchObject({ entryId: f.checkpoint.entryId, entryEffectSeq: f.checkpoint.sequence,
      entryEffectAt: f.checkpoint.time })
    expect(hash(JSON.stringify(witness))).toBe(f.checkpoint.witnessDigest)
    expect(() => new RuntimeEntryJournal(f.checkpoint.path)).toThrow()
    expect(snapshot(f.root)).toEqual(before)
    console.log('CONTROL: actual COMMIT/readback -> SIGKILL -> original known-ID reader exact, wx retained, recovery start/wake/model=0')
  })
  it('locates that original committed entry through the current private endpoint without reacquiring the writer or waking business', async () => {
    const f = await crash(), before = snapshot(f.root), workerId = randomUUID(), token = 'C'.repeat(43)
    vi.stubEnv('DSH_PROFILE_WORKER_ID', workerId)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const callbacks = { dispatch: 0, open: 0 }
    const owner = new DesktopCollaborationAnalysis(async () => { callbacks.dispatch++; throw Error('no recovery dispatch') },
      async () => { callbacks.open++; throw Error('no new analysis journal') }, new AbortController().signal)
    onTestFinished(() => owner.close())
    const profile = await openCrashProfile(f.root)
    f.resources.close = () => profile.close()
    const nativeStarts = vi.spyOn(profile.ctx.sessionController, 'collaborationRuntimeEntryConsumption')
    const legacyStarts = vi.spyOn(profile.ctx.sessionController, 'collaborationRootConsumption')
    const agentCreates = vi.spyOn(profile.ctx.agentLoop, 'create')
    vi.stubEnv('DSH_HOME', f.root)
    const original = await profile.ctx.sessionController.inspectRuntimeEntryConsumer(f.checkpoint.operation, new AbortController().signal)
    expect(original?.state).toBe('started')
    expect(hash(JSON.stringify(original))).toBe(f.checkpoint.startedRecordDigest)
    const pins = ['../../../api/session-controller/src/runtime-entry-journal.ts', '../src/desktop-runtime-entry-host.ts'].map((relative) => {
      const path = fileURLToPath(new URL(relative, import.meta.url)); return { path, sha256: hash(readFileSync(path)) }
    })
    const configuration = { schemaVersion: 1 as const, implementationDigest: '1'.repeat(64), compositionDigest: '2'.repeat(64), artifactPins: pins }
    const keys = generateKeyPairSync('ed25519')
    const keyring = { version: 1 as const, environmentId: '10000000-0000-4000-8000-000000000001', issuer: 'https://cloud-control.example.test',
      keys: [{ kid: 'controlled-crash-key', publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        validFrom: Date.now() - 60000, validUntil: Date.now() + 60000 }] }
    const lifetime = new AbortController()
    let native: DesktopRuntimeEntryHost | undefined
    expect(() => { native = new DesktopRuntimeEntryHost(profile.ctx, configuration, [keyring], f.checkpoint.profileId,
      workerId, lifetime.signal) }).toThrow()
    expect(native).toBeUndefined()
    const cold = createDesktopRuntimeEntryLocator(profile.ctx, configuration, f.checkpoint.profileId, lifetime.signal)
    expect(await cold(f.checkpoint.operation, new AbortController().signal)).toEqual({ entryId: f.checkpoint.entryId })
    const readBefore = snapshot(f.root)
    const baseline = process.env.REQ0006_CRASH_BASELINE_HTTP
    const handler: typeof handleDesktopCollaborationAnalysisRequest = baseline
      ? (await import(/* @vite-ignore */ pathToFileURL(baseline).href) as HttpHandlerModule).handleDesktopCollaborationAnalysisRequest
      : handleDesktopCollaborationAnalysisRequest
    const server = createServer((req, res) => { void handler(req, res, token, owner, native, cold) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
    const address = server.address(); if (!address || typeof address === 'string') throw Error('missing private test HTTP port')
    const witness = readRuntimeEntryWitness(f.checkpoint.path, f.checkpoint.entryId)
    if (!witness) throw Error('missing actual committed witness')
    const b = witness.receipt.binding
    const operation = parseRuntimeEntryOriginCommand(f.checkpoint.operation)
    const vector = JSON.parse(readFileSync(new URL(
      '../../../host/control-protocol/tests/fixtures/runtime-entry-metadata-authorization-v1.json', import.meta.url), 'utf8')) as { value: unknown }
    const metadata = parseRuntimeEntryMetadataAuthorization(vector.value)
    const actualAccount = { authorityEnvironmentId: b.authorityEnvironmentId, accountIssuer: metadata.accountIssuer,
      accountSubject: metadata.accountSubject, accountBindingId: metadata.accountBindingId,
      accountBindingVersion: metadata.accountBindingVersion, hostProfileId: b.hostProfileId }
    const response = await fetch('http://127.0.0.1:' + String(address.port), { method: 'POST', headers: { authorization: 'Bearer ' + token,
      'content-type': 'application/json' }, body: JSON.stringify({ action: 'runtime_entry_locate', operation, binding_key: 'a'.repeat(64),
      actualAccount, actualPeer: metadata.peer, actualWorkerId: workerId }) })
    const body: unknown = await response.json()
    expect(snapshot(f.root)).toEqual(readBefore)
    expect(readFileSync(f.checkpoint.path + '.writer-lock')).toHaveLength(0)
    expect(hash(readFileSync(f.checkpoint.path))).toBe(before['runtime-entry.sqlite'])
    expect(callbacks).toEqual({ dispatch: 0, open: 0 })
    console.log('OBSERVATION:', JSON.stringify({ status: response.status, body, original: f.checkpoint,
      originalFilesUnchanged: true, recoveryConsumerStarts: 0, recoveryWakes: 0, recoveryModels: 0 }))
    expect(response.status, 'original committed entry locate must not require an exclusive Native writer').toBe(200)
    expect(body).toEqual({ value: { entryId: f.checkpoint.entryId } })
    const unchanged = snapshot(f.root)
    await expect(cold({ ...operation, attemptId: f.checkpoint.attemptId }, new AbortController().signal)).rejects.toThrow()
    await expect(cold({ ...operation, target: { ...operation.target, workspace_id: randomUUID() } },
      new AbortController().signal)).rejects.toThrow('workspace_not_found')
    await expect(cold({ ...operation, selection: { ...operation.selection, task_id: 'another-task' } },
      new AbortController().signal)).rejects.toThrow('execution_missing')
    const wrongProfile = createDesktopRuntimeEntryLocator(profile.ctx, configuration, randomUUID(), lifetime.signal)
    await expect(wrongProfile(operation, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(readRuntimeEntryWitnessByAttempt(f.checkpoint.path, randomUUID(), f.checkpoint.commandId)).toBeUndefined()
    expect(() => readRuntimeEntryWitnessByAttempt(f.checkpoint.path, f.checkpoint.attemptId, randomUUID())).toThrow('original_mismatch')
    expect(snapshot(f.root)).toEqual(unchanged)
    expect(nativeStarts).not.toHaveBeenCalled()
    expect(legacyStarts).not.toHaveBeenCalled()
    expect(agentCreates).not.toHaveBeenCalled()
    expect(profile.adapter.requests).toHaveLength(0)
    expect(await profile.ctx.sessionController.inspectRuntimeEntryConsumer(operation, new AbortController().signal)).toEqual(original)
    expect(hash(JSON.stringify(readRuntimeEntryWitness(f.checkpoint.path, f.checkpoint.entryId)))).toBe(f.checkpoint.witnessDigest)
  })
  it('cold attempt reader refuses draft, unknown, WAL and corrupt sources without touching their complete files', async () => {
    const f = await crash()
    for (const mode of ['draft', 'unknown', 'wal', 'corrupt']) {
      const root = join(f.root, mode); mkdirSync(root, { mode: 0o700 })
      const path = join(root, 'runtime-entry.sqlite')
      copyFileSync(f.checkpoint.path, path); chmodSync(path, 0o600)
      copyFileSync(f.checkpoint.path + '.writer-lock', path + '.writer-lock')
      let raw: DatabaseSync | undefined
      try {
        if (mode === 'draft') {
          raw = new DatabaseSync(path)
          raw.exec('DROP TRIGGER runtime_entry_publication_pairs_no_update; DROP TRIGGER runtime_entry_publication_pairs_no_delete; DROP TABLE runtime_entry_publication_pairs')
          raw.close(); raw = undefined
        } else if (mode === 'unknown') writeFileSync(path, Buffer.from('unknown private source format'))
        else if (mode === 'corrupt') writeFileSync(path, readFileSync(path).subarray(0, 100))
        else {
          raw = new DatabaseSync(path)
          raw.exec('PRAGMA journal_mode=WAL; CREATE TABLE pending_wal_probe(id INTEGER); DROP TABLE pending_wal_probe')
        }
        const before = snapshot(root)
        expect(() => readRuntimeEntryWitnessByAttempt(path, f.checkpoint.attemptId, f.checkpoint.commandId)).toThrow()
        expect(snapshot(root)).toEqual(before)
      } finally { raw?.close() }
    }
    expect(hash(JSON.stringify(readRuntimeEntryWitness(f.checkpoint.path, f.checkpoint.entryId)))).toBe(f.checkpoint.witnessDigest)
  })

})
