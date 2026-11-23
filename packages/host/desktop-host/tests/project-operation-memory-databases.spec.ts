import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ProjectOperationMemoryDatabases } from '../src/project-operation-memory-databases.ts'
import { ProjectOperationMemorySourceExports } from '../src/project-operation-memory-source-exports.ts'
import { ProjectMemoryOwnershipRetainedError } from '../src/project-operation-memory-ownership-error.ts'
import { memoryDatabaseFixture } from './project-operation-memory.test-support.ts'
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectOperationMemoryDatabaseFiles } from '../src/project-operation-memory-database-files.ts'
import { projectMemoryDatabaseLayout } from '../src/project-operation-memory-layout.ts'
import type { ProjectMemoryDatabaseRole } from '../src/project-operation-memory-layout.ts'
import { ProjectOperationMemoryMetadata } from '../src/project-operation-memory-metadata.ts'
import { ProjectOperationMemoryNativeSource } from '../src/project-operation-memory-native-source.ts'
import { ProjectOperationMemoryRecipientImports } from '../src/project-operation-memory-recipient-imports.ts'
import { TwinBindingReceipts } from '../src/twin-binding-receipts.ts'
import { createPosixTwinBindingReceiptFile } from '../src/twin-binding-receipt-files.ts'

async function fixture() {
  const key = generateKeyPairSync('ed25519')
  return memoryDatabaseFixture({
    profileId: randomUUID(),
    installationId: randomUUID(),
    publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
  })
}
// These cases use actual POSIX owner-private files. Windows metadata contracts run in the dedicated native suites.
describe.skipIf(process.platform === 'win32')('POSIX private memory composition', () => {
  it('shares each Profile owner and shutdown fence across platform metadata factories', async () => {
    const { database, options } = await fixture(),
      create = vi.fn(async () => database),
      owners = new ProjectOperationMemoryDatabases(create),
      services = owners.services({ installationId: options.installationId, publicKey: options.publicKey }, []),
      metadata = await services.createProjectOperationMemoryMetadata(options.profileId)
    expect(metadata.database).toBe(database)
    expect(await services.createProjectOperationMemorySourceExports(options.profileId)).toBeInstanceOf(
      ProjectOperationMemorySourceExports,
    )
    expect(services.projectOperationMemoryEnvironments).toEqual([])
    expect(create).toHaveBeenCalledExactlyOnceWith(options.profileId)
    await owners.close()
    await expect(services.createProjectOperationMemoryMetadata(options.profileId)).rejects.toThrow()
    await expect(services.createProjectOperationMemorySourceExports(options.profileId)).rejects.toThrow()
  })
  it('caches one actual Profile owner and rejects new factories after confirmed shutdown', async () => {
    const { database, options } = await fixture(),
      create = vi.fn(async () => database),
      owners = new ProjectOperationMemoryDatabases(create)
    expect(owners.get(options.profileId)).toBe(owners.get(options.profileId))
    expect(await owners.get(options.profileId)).toBe(database)
    expect(create).toHaveBeenCalledTimes(1)
    await owners.close()
    await owners.close()
    expect(() => database.usage()).toThrow()
    await expect(owners.get(randomUUID())).rejects.toThrow()
  })
  it('quiesces an in-flight real owner and prevents a queued factory from opening after shutdown', async () => {
    const { database, options } = await fixture()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
        release = resolve
      }),
      create = vi.fn(async () => {
        await barrier
        return database
      }),
      owners = new ProjectOperationMemoryDatabases(create),
      pending = owners.get(options.profileId)
    await Promise.resolve()
    const closing = owners.close()
    release()
    expect(await pending).toBe(database)
    await closing
    expect(() => database.usage()).toThrow()
    const lateCreate = vi.fn(async () => database),
      late = new ProjectOperationMemoryDatabases(lateCreate),
      queued = late.get(options.profileId)
    await late.close()
    await expect(queued).rejects.toThrow()
    expect(lateCreate).not.toHaveBeenCalled()
  })
  it('retains failed initialization identities while safely cleaned unknown formats do not prevent shutdown', async () => {
    const clean = vi.fn(async () => {
        throw Error('unknown format refused and closed')
      }),
      owners = new ProjectOperationMemoryDatabases(clean)
    await expect(owners.get('original')).rejects.toThrow('unknown format')
    await expect(owners.get('original')).rejects.toThrow('unknown format')
    expect(clean).toHaveBeenCalledTimes(1)
    await owners.close()
    const unsafe = new ProjectOperationMemoryDatabases(async () => {
      throw new ProjectMemoryOwnershipRetainedError(Error('handle retained'))
    })
    await expect(unsafe.get('original')).rejects.toBeInstanceOf(ProjectMemoryOwnershipRetainedError)
    await expect(unsafe.close()).rejects.toBeInstanceOf(ProjectMemoryOwnershipRetainedError)
  })
  it('propagates actual close failures so platform quiescence cannot release outer Host ownership', async () => {
    const { database, options } = await fixture(),
      owners = new ProjectOperationMemoryDatabases(async () => database)
    await owners.get(options.profileId)
    const failure = vi.spyOn(database, 'close').mockRejectedValueOnce(Error('SQLite still live'))
    await expect(owners.close()).rejects.toThrow('project_memory_ownership_retained')
    await expect(owners.close()).rejects.toThrow('project_memory_ownership_retained')
    failure.mockRestore()
    await database.close()
  })
})

it.skipIf(process.platform === 'win32')('opens each memory owner once per Profile and releases all private SQLite files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-memory-owners-'))
  const profileId = randomUUID()
  const profileRoot = join(root, profileId)
  mkdirSync(profileRoot, { mode: 0o700 })
  const key = generateKeyPairSync('ed25519')
  const installation = {
    installationId: randomUUID(),
    publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
  }
  const roles: ProjectMemoryDatabaseRole[] = ['source', 'recipient', 'native']
  const opened = new Map<ProjectMemoryDatabaseRole, string>()
  const processNonce = randomUUID()
  const uid = process.getuid!()
  const openFiles = (requestedProfile: string, role: ProjectMemoryDatabaseRole) => {
    expect(requestedProfile).toBe(profileId)
    return ProjectOperationMemoryDatabaseFiles.posix({
      ...projectMemoryDatabaseLayout(profileRoot, role, join),
      ...installation,
      profileId,
      uid,
      pid: process.pid,
      processNonce,
    })
  }
  const databases = ProjectOperationMemoryDatabases.forFiles(async (requestedProfile, role) => {
    expect(opened.has(role)).toBe(false)
    const files = await openFiles(requestedProfile, role)
    opened.set(role, files.path)
    return files
  })
  try {
    const confirmations = new TwinBindingReceipts({
      ...installation,
      profileId,
      file: createPosixTwinBindingReceiptFile(join(profileRoot, 'confirmations'), uid),
    })
    const services = databases.services(installation, [])
    expect(opened.size).toBe(0)
    const createNative = services.createProjectOperationMemoryNativeSource
    expect(createNative).toBeTypeOf('function')
    const [first, second, recipient, native] = await Promise.all([
      services.createProjectOperationMemoryMetadata(profileId),
      services.createProjectOperationMemoryMetadata(profileId),
      services.createProjectOperationMemoryRecipientImports(profileId, confirmations),
      createNative!(profileId),
    ])
    expect(first).toBeInstanceOf(ProjectOperationMemoryMetadata)
    expect(second).toBeInstanceOf(ProjectOperationMemoryMetadata)
    expect(recipient).toBeInstanceOf(ProjectOperationMemoryRecipientImports)
    expect(native).toBeInstanceOf(ProjectOperationMemoryNativeSource)
    expect([...opened.keys()].sort()).toEqual([...roles].sort())
    expect(new Set(opened.values()).size).toBe(roles.length)
    for (const role of roles) {
      expect(lstatSync(opened.get(role)!).mode & 0o777).toBe(0o600)
      await expect(openFiles(profileId, role)).rejects.toThrow()
    }

    const closing = databases.close()
    expect(databases.close()).toBe(closing)
    await closing
    await expect(services.createProjectOperationMemoryMetadata(profileId)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(services.createProjectOperationMemoryRecipientImports(profileId, confirmations)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(createNative!(profileId)).rejects.toMatchObject({ code: 'unavailable' })
    for (const role of roles) {
      const files = await openFiles(profileId, role)
      try {
        expect(files.path).toBe(opened.get(role))
        expect(files.published).toBe(true)
      } finally {
        files.releaseSidecars()
        await files.releaseAfterDatabaseClose()
      }
    }
  } finally {
    await databases.close()
    rmSync(root, { recursive: true, force: true })
  }
})
