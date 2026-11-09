import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ProjectOperationMemoryDatabases } from '../src/project-operation-memory-databases.ts'
import { ProjectMemoryOwnershipRetainedError } from '../src/project-operation-memory-ownership-error.ts'
import { memoryDatabaseFixture } from './project-operation-memory.test-support.ts'

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
