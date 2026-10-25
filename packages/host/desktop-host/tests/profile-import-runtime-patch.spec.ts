import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import { existingProfilePatch, releasedSettingsProfilePatch } from '../src/offline-profile-recovery.ts'
import { FileProfileImportRuntimePatch } from '../src/profile-import-runtime-patch.ts'

const uid = process.getuid?.() ?? 0
const ownerState: MigrationOwnerStateBundle = { version: 1, documents: [
  { kind: 'settings', schemaVersion: 1, value: {} },
  { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
  { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
  { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
] }

async function fixture() {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-import-runtime-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(profileRoot, 'persistence'), uid, 1)
  const old = await target.activePersistenceConfig()
  await target.importOwnerState(1, ownerState)
  const applicator = new MigrationOwnerStateApplicator(uid)
  const oldPaths = await applicator.apply(profileRoot, 1, ownerState)
  const patchPath = join(profileRoot, 'cordis.patch.yml')
  const oldPatch = existingProfilePatch(profileRoot, old, oldPaths)
  await writeFile(patchPath, oldPatch, { mode: 0o600 })
  await target.prepareEmptyGeneration(2)
  await target.importOwnerState(2, ownerState)
  const operationId = randomUUID()
  const runtime = new FileProfileImportRuntimePatch(profileRoot, operationId, target, applicator, uid)
  return { target, runtime, patchPath, oldPatch, profileRoot, operationId }
}

it.skipIf(process.platform === 'win32')('switches candidate patch idempotently and restores original bytes after rollback', async () => {
  const { target, runtime, patchPath, oldPatch } = await fixture()
  await target.commitGeneration(1, 2)
  await runtime.publishCandidate(1, 2)
  const candidate = await readFile(patchPath, 'utf8')
  expect(candidate).toContain('/migration-owner-state/2/')
  expect(candidate).toContain('/persistence/generations/2')
  await runtime.publishCandidate(1, 2)
  expect(await readFile(patchPath, 'utf8')).toBe(candidate)
  await target.commitGeneration(2, 1)
  await runtime.restoreOld(1, 2)
  await runtime.restoreOld(1, 2)
  expect(await readFile(patchPath, 'utf8')).toBe(oldPatch)
})

it.skipIf(process.platform === 'win32')('recovers a crash after pointer switch but before patch publication', async () => {
  const { target, runtime, patchPath, oldPatch } = await fixture()
  await target.commitGeneration(1, 2)
  await target.commitGeneration(2, 1)
  await runtime.restoreOld(1, 2)
  expect(await readFile(patchPath, 'utf8')).toBe(oldPatch)
})

it.skipIf(process.platform === 'win32')('preserves the exact released settings patch on rollback', async () => {
  const { target, runtime, patchPath, profileRoot } = await fixture()
  const paths = await new MigrationOwnerStateApplicator(uid).inspectExisting(profileRoot, 1)
  const released = releasedSettingsProfilePatch(profileRoot, await target.activePersistenceConfig(), paths)
  await writeFile(patchPath, released, { mode: 0o600 })
  await target.commitGeneration(1, 2)
  await runtime.publishCandidate(1, 2)
  await target.commitGeneration(2, 1)
  await runtime.restoreOld(1, 2)
  expect(await readFile(patchPath, 'utf8')).toBe(released)
})

it.skipIf(process.platform === 'win32')('refuses an unexpected live patch without changing it', async () => {
  const { target, runtime, patchPath } = await fixture()
  await target.commitGeneration(1, 2)
  await writeFile(patchPath, 'unexpected\n', { mode: 0o600 })
  await expect(runtime.publishCandidate(1, 2)).rejects.toThrow('profile_import_runtime_patch_changed')
  expect(await readFile(patchPath, 'utf8')).toBe('unexpected\n')
})

it.skipIf(process.platform === 'win32')('refuses a writable live patch before publishing', async () => {
  const { target, runtime, patchPath } = await fixture()
  await target.commitGeneration(1, 2)
  await chmod(patchPath, 0o666)
  await expect(runtime.publishCandidate(1, 2)).rejects.toThrow('profile_import_runtime_patch_unsafe')
})

it.skipIf(process.platform === 'win32')('refuses a changed backup after pointer rollback', async () => {
  const { target, runtime, patchPath, profileRoot, operationId } = await fixture()
  await target.commitGeneration(1, 2)
  await runtime.publishCandidate(1, 2)
  const candidatePatch = await readFile(patchPath, 'utf8')
  await target.commitGeneration(2, 1)
  await writeFile(join(profileRoot, 'profile-import-runtime-patches', `${operationId}.patch`), 'tampered')
  await expect(runtime.restoreOld(1, 2)).rejects.toThrow('profile_import_runtime_patch_changed')
  expect(await readFile(patchPath, 'utf8')).toBe(candidatePatch)
})
