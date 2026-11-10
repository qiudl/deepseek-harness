/** Permanent cut/Ack admission reserves the exact escaped future metadata, not a guessed receipt. */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { collaborationJournalDigest as hash } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-source-journal.ts'
import { openCollaborationTaskCoordinationJournal } from '@deepseek-ai/dsh-api-session-controller/src/collaboration-task-coordination-journal.ts'
import { taskFixture, isTaskJsonObject } from './task-coordination.test-support.ts'

it('fills the actual metadata quota after cut admission and still persists its original signed Ack without touching released journals',
  { timeout: 15000 }, async () => {
    const f = await taskFixture(), transferRequestId = randomUUID(), capacity = 64 * 1024 * 1024
    f.peer.computerId = 'quoted-"computer'
    const paths = ['collaboration_source_v2', 'collaboration_root_submission_v1', 'collaboration_root_execution_v1']
      .map(name => join(f.directory, 'domains', name + '.json'))
    const before = await Promise.all(paths.map(path => readFile(path)))
    const receiver = f.options.receiver
    let filled = false, used = 0
    f.options.receiver = () => {
      const original = receiver()
      return { ...original, execute: async (command, signal) => {
        if (!filled && isTaskJsonObject(command)
          && command.action === 'task_coordination_commit_ack') {
          filled = true
          const cut = f.journal.artifact('cut:' + transferRequestId)
          if (!cut) throw Error('missing genuinely admitted original cut')
          used = Buffer.byteLength(JSON.stringify(cut)) + cut.reservedBytes
          for (let index = 0; used < capacity; index++) {
            const base = { key: 'capacity:' + String(index), floorDigest: cut.floorDigest, scopeDigest: cut.scopeDigest,
              transferRequestId, kind: 'inventory' as const, expiresAt: f.time.value + 15000, reservedBytes: 0,
              json: '', digest: '0'.repeat(64) }
            const overhead = Buffer.byteLength(JSON.stringify(base))
            const length = Math.min(16 * 1024 * 1024, capacity - used - overhead)
            if (length < 0) throw Error('capacity fixture cannot reach the exact admitted boundary')
            const json = 'x'.repeat(length), artifact = { ...base, json, digest: hash(json) }
            await f.journal.retainArtifact(artifact, f.time.value)
            used += Buffer.byteLength(JSON.stringify(artifact))
          }
          expect(used).toBe(capacity)
        }
        return original.execute(command, signal)
      } }
    }
    const result = await f.operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }))
    expect(result).toMatchObject({ ok: true, record: { status: 'closed' } })
    expect(f.journal.artifact('ack:' + transferRequestId)).toBeTruthy()
    expect(await f.operate(f.create({ operation: 'receipt', transferRequestId }))).toMatchObject({ ok: true, record: { status: 'found' } })
    const cut = f.journal.artifact('cut:' + transferRequestId)
    if (!cut) throw Error('missing retained original cut')
    await expect(f.journal.retainArtifact({ key: 'capacity:extra', floorDigest: cut.floorDigest, scopeDigest: cut.scopeDigest,
      transferRequestId, kind: 'inventory', expiresAt: f.time.value + 15000, reservedBytes: 0, json: 'extra', digest: hash('extra') }, f.time.value))
      .rejects.toThrow('task_coordination_capacity')
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
    await f.journal.close()
    const path = join(f.directory, 'domains', 'collaboration_task_coordination_v1.json')
    const stored = JSON.parse(await readFile(path, 'utf8')) as { tables: { artifacts: Record<string, unknown> } }
    stored.tables.artifacts['capacity:external-corruption'] = { key: 'capacity:external-corruption', floorDigest: cut.floorDigest,
      scopeDigest: cut.scopeDigest, transferRequestId, kind: 'inventory', expiresAt: f.time.value + 15000,
      reservedBytes: 0, json: 'over-capacity', digest: hash('over-capacity') }
    await writeFile(path, JSON.stringify(stored))
    await expect(openCollaborationTaskCoordinationJournal(f.facility)).rejects.toThrow('task_coordination_capacity')
  })
