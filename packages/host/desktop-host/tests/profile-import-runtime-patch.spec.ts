import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import { existingProfilePatch, releasedSettingsProfilePatch } from '../src/offline-profile-recovery.ts'
import { FileProfileImportRuntimePatch } from '../src/profile-import-runtime-patch.ts'

const fsFaults = vi.hoisted(() => ({ mode: '' as '' | 'mkdir-denied' | 'read-change'
  | 'backup-open-denied' | 'unlink-denied', reads: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(Error('injected permission failure'), { code: 'EACCES' })
  return { ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (fsFaults.mode === 'mkdir-denied'
        && String(args[0]).endsWith('/profile-import-runtime-patches')) throw denied()
      return actual.mkdir(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0])
      if (fsFaults.mode === 'backup-open-denied' && path.endsWith('.patch')) throw denied()
      const handle = await actual.open(...args)
      if (fsFaults.mode === 'read-change' && path.endsWith('/cordis.patch.yml')) {
        const stat = handle.stat.bind(handle)
        Object.defineProperty(handle, 'stat', { value: async (options: { bigint: true }) => {
          const metadata = await stat(options)
          if (++fsFaults.reads === 2) {
            Object.defineProperty(metadata, 'mtimeNs', { value: metadata.mtimeNs + 1n })
          }
          return metadata
        } })
      }
      return handle
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (fsFaults.mode === 'unlink-denied' && String(args[0]).endsWith('.tmp')) throw denied()
      return actual.unlink(...args)
    },
  }
})

const uid = process.getuid?.() ?? 0
const ownerState: MigrationOwnerStateBundle = { version: 1, documents: [
  { kind: 'settings', schemaVersion: 1, value: {} },
  { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
  { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
  { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
] }

async function fixture() {
  fsFaults.mode = ''
  fsFaults.reads = 0
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
  return { target, runtime, applicator, patchPath, oldPatch, profileRoot, operationId }
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

it.skipIf(process.platform === 'win32')('rejects invalid construction and a pointer at the wrong generation', async () => {
  const { target, runtime, profileRoot } = await fixture()
  const applicator = new MigrationOwnerStateApplicator(uid)
  expect(() => new FileProfileImportRuntimePatch('relative', randomUUID(), target, applicator, uid))
    .toThrow('profile_import_runtime_patch_invalid')
  expect(() => new FileProfileImportRuntimePatch(profileRoot, 'invalid', target, applicator, uid))
    .toThrow('profile_import_runtime_patch_invalid')
  await expect(runtime.publishCandidate(1, 2)).rejects.toThrow('profile_import_generation_changed')
  await target.commitGeneration(1, 2)
  await expect(runtime.restoreOld(1, 2)).rejects.toThrow('profile_import_generation_changed')
})

it.skipIf(process.platform === 'win32')('rejects unsafe backups and resumes a matching immutable backup', async () => {
  const { target, runtime, profileRoot, operationId, patchPath, oldPatch } = await fixture()
  await target.commitGeneration(1, 2)
  const backupRoot = join(profileRoot, 'profile-import-runtime-patches')
  const backup = join(backupRoot, `${operationId}.patch`)
  await mkdir(backupRoot, { mode: 0o700 })
  await chmod(backupRoot, 0o755)
  await expect(runtime.publishCandidate(1, 2)).rejects.toThrow('profile_import_runtime_patch_unsafe')
  await chmod(backupRoot, 0o700)
  await symlink(patchPath, backup)
  await expect(runtime.publishCandidate(1, 2)).rejects.toMatchObject({ code: 'ELOOP' })
  await unlink(backup)
  await writeFile(backup, oldPatch, { mode: 0o600 })
  await runtime.publishCandidate(1, 2)
  expect(await readFile(backup, 'utf8')).toBe(oldPatch)
  await target.commitGeneration(2, 1)
  await runtime.restoreOld(1, 2)
  expect(await readFile(patchPath, 'utf8')).toBe(oldPatch)
})

it.skipIf(process.platform === 'win32')('rejects absent, empty, and unrelated live patch bytes', async () => {
  const first = await fixture()
  await first.target.commitGeneration(1, 2)
  await writeFile(first.patchPath, '', { mode: 0o600 })
  await expect(first.runtime.publishCandidate(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_unsafe')
  const second = await fixture()
  await writeFile(second.patchPath, 'unrelated\n', { mode: 0o600 })
  await expect(second.runtime.restoreOld(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_changed')
})

it.skipIf(process.platform === 'win32')('accepts a missing backup file and rejects conflicting saved intent', async () => {
  const first = await fixture()
  await first.target.commitGeneration(1, 2)
  await mkdir(join(first.profileRoot, 'profile-import-runtime-patches'), { mode: 0o700 })
  await first.runtime.publishCandidate(1, 2)
  const second = await fixture()
  await second.target.commitGeneration(1, 2)
  const backupRoot = join(second.profileRoot, 'profile-import-runtime-patches')
  await mkdir(backupRoot, { mode: 0o700 })
  await writeFile(join(backupRoot, `${second.operationId}.patch`), 'unrelated\n', { mode: 0o600 })
  await expect(second.runtime.publishCandidate(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_changed')
})

it.skipIf(process.platform === 'win32')('rejects a live patch replaced between authority checks and rollback', async () => {
  const first = await fixture()
  await first.target.commitGeneration(1, 2)
  const apply = first.applicator.apply.bind(first.applicator)
  vi.spyOn(first.applicator, 'apply').mockImplementationOnce(async (...args) => {
    const paths = await apply(...args)
    await writeFile(first.patchPath, 'replaced after initial check\n', { mode: 0o600 })
    return paths
  })
  await expect(first.runtime.publishCandidate(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_changed')
  const second = await fixture()
  await second.target.commitGeneration(1, 2)
  await second.runtime.publishCandidate(1, 2)
  await writeFile(second.patchPath, 'unexpected after publication\n', { mode: 0o600 })
  await expect(second.runtime.publishCandidate(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_changed')
  await second.target.commitGeneration(2, 1)
  await expect(second.runtime.restoreOld(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_changed')
})

it.skipIf(process.platform === 'win32')('fails closed on backup creation, read, and cleanup faults', async () => {
  const first = await fixture()
  await first.target.commitGeneration(1, 2)
  fsFaults.mode = 'mkdir-denied'
  await expect(first.runtime.publishCandidate(1, 2)).rejects.toMatchObject({ code: 'EACCES' })
  const second = await fixture()
  await second.target.commitGeneration(1, 2)
  fsFaults.mode = 'read-change'
  await expect(second.runtime.publishCandidate(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_changed')
  const third = await fixture()
  await third.target.commitGeneration(1, 2)
  fsFaults.mode = 'backup-open-denied'
  await expect(third.runtime.publishCandidate(1, 2))
    .rejects.toThrow('profile_import_runtime_patch_changed')
  const fourth = await fixture()
  await fourth.target.commitGeneration(1, 2)
  fsFaults.mode = 'unlink-denied'
  await expect(fourth.runtime.publishCandidate(1, 2)).rejects.toMatchObject({ code: 'EACCES' })
})
