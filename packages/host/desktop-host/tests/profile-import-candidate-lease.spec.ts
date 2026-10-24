import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, link, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { FileProfileImportCandidateLease } from '../src/profile-import-candidate-lease.ts'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'

it.runIf(process.platform === 'linux')('rejects macOS orphan signalling without inspecting the lease', async () => {
  const lease = new FileProfileImportCandidateLease('/nonexistent-profile', randomUUID(), process.getuid!())
  await expect(lease.stopOrphan({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: '/unused', assertAuthority: () => { throw Error('should_not_run') } }))
    .rejects.toThrow('profile_import_candidate_stop_unsupported')
})

it.skipIf(process.platform === 'win32')('keeps the candidate lifetime lock through Host fd close and child exit', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  const child: { current?: ChildProcess } = {}
  onTestFinished(async () => {
    child.current?.kill('SIGKILL')
    await rm(profileRoot, { recursive: true, force: true })
  })
  const uid = process.getuid!()
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), uid)
  const handle = await lease.acquireForSpawn()
  child.current = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore', handle.fd],
  })
  const processHandle = child.current
  await handle.close()
  if (!processHandle.stdout) throw Error('candidate_stdout_missing')
  await once(processHandle.stdout, 'data')
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_running')
  processHandle.kill('SIGTERM')
  await once(processHandle, 'exit')
  await expect(lease.assertStopped()).resolves.toBeUndefined()
})

it.skipIf(process.platform === 'win32')('refuses a redirected candidate lease directory', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  await symlink(tmpdir(), join(profileRoot, 'profile-import-candidate-leases'))
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), process.getuid!())
  await expect(lease.acquireForSpawn()).rejects.toThrow('profile_import_candidate_lease_unsafe')
})

it.skipIf(process.platform === 'win32')('fails closed when the lifetime witness is missing', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), process.getuid!())
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_missing')
})

it.skipIf(process.platform === 'win32')('rejects invalid lease authority before touching disk', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  expect(() => new FileProfileImportCandidateLease('relative', randomUUID(), process.getuid!()))
    .toThrow('profile_import_candidate_lease_invalid')
  expect(() => new FileProfileImportCandidateLease(profileRoot, 'invalid', process.getuid!()))
    .toThrow('profile_import_candidate_lease_invalid')
  expect(() => new FileProfileImportCandidateLease(profileRoot, randomUUID(), -1))
    .toThrow('profile_import_candidate_lease_invalid')
})

it.skipIf(process.platform === 'win32')('refuses a missing or edited inode identity record', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const operationId = randomUUID()
  const lease = new FileProfileImportCandidateLease(profileRoot, operationId, process.getuid!())
  const handle = await lease.acquireForSpawn()
  await handle.close()
  const identity = join(profileRoot, 'profile-import-candidate-leases', `${operationId}.identity`)
  const expectedIdentity = await readFile(identity, 'utf8')
  await unlink(identity)
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_missing')
  await writeFile(identity, 'tampered\n', { mode: 0o600 })
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_unsafe')
  const lock = join(profileRoot, 'profile-import-candidate-leases', `${operationId}.lock`)
  const original = await readFile(lock)
  await writeFile(identity, `${expectedIdentity.startsWith('0') ? '1' : '0'}${expectedIdentity.slice(1)}`, { mode: 0o600 })
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_changed')
  expect(await readFile(lock)).toEqual(original)
})

it.skipIf(process.platform === 'win32')('refuses writable or multiply linked lease witnesses', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const operationId = randomUUID()
  const lease = new FileProfileImportCandidateLease(profileRoot, operationId, process.getuid!())
  const handle = await lease.acquireForSpawn()
  await handle.close()
  const lock = join(profileRoot, 'profile-import-candidate-leases', `${operationId}.lock`)
  await chmod(lock, 0o644)
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_unsafe')
  await chmod(lock, 0o600)
  await link(lock, join(profileRoot, 'profile-import-candidate-leases', 'second-link'))
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_unsafe')
})

it.skipIf(process.platform === 'win32')('refuses an identity record with another hard link', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const operationId = randomUUID()
  const lease = new FileProfileImportCandidateLease(profileRoot, operationId, process.getuid!())
  const handle = await lease.acquireForSpawn()
  await handle.close()
  const directory = join(profileRoot, 'profile-import-candidate-leases')
  await link(join(directory, `${operationId}.identity`), join(directory, 'identity-link'))
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_unsafe')
})

it.skipIf(process.platform === 'win32')('refuses a missing lock and an unsafe owner directory', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const operationId = randomUUID()
  const lease = new FileProfileImportCandidateLease(profileRoot, operationId, process.getuid!())
  const handle = await lease.acquireForSpawn()
  await handle.close()
  await unlink(join(profileRoot, 'profile-import-candidate-leases', `${operationId}.lock`))
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_missing')
  await chmod(profileRoot, 0o755)
  await expect(lease.acquireForSpawn()).rejects.toThrow('profile_import_candidate_lease_unsafe')
})

it.skipIf(process.platform === 'win32')('refuses a second candidate while the first owns the lease', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), process.getuid!())
  const handle = await lease.acquireForSpawn()
  try {
    await expect(lease.acquireForSpawn()).rejects.toThrow('profile_import_candidate_running')
    await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_running')
  } finally { await handle.close() }
  await expect(lease.assertStopped()).resolves.toBeUndefined()
})

it.skipIf(process.platform === 'win32')('refuses a redirected identity record', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const operationId = randomUUID()
  const lease = new FileProfileImportCandidateLease(profileRoot, operationId, process.getuid!())
  const handle = await lease.acquireForSpawn()
  await handle.close()
  const directory = join(profileRoot, 'profile-import-candidate-leases')
  const identity = join(directory, `${operationId}.identity`)
  await unlink(identity)
  await symlink(join(directory, `${operationId}.lock`), identity)
  await expect(lease.assertStopped()).rejects.toThrow()
})

it.skipIf(process.platform === 'win32')('refuses a lock file replaced after activation', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const operationId = randomUUID()
  const lease = new FileProfileImportCandidateLease(profileRoot, operationId, process.getuid!())
  const handle = await lease.acquireForSpawn()
  await handle.close()
  const lock = join(profileRoot, 'profile-import-candidate-leases', `${operationId}.lock`)
  const replacement = join(profileRoot, 'profile-import-candidate-leases', 'replacement')
  await writeFile(replacement, '', { mode: 0o600 })
  await rename(replacement, lock)
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_lease_changed')
})

it.skipIf(process.platform === 'win32')('releases the inherited lease after a failed candidate launch', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const entrypoint = join(profileRoot, 'worker.mjs')
  await writeFile(entrypoint, 'setInterval(() => {}, 1000)')
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), process.getuid!())
  const handle = await lease.acquireForSpawn()
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: entrypoint, readyTimeoutMs: 100 })
  await expect(factory.createImportCandidate({ profileId: 'candidate', profileRoot,
    credentialHandle: 'test', pluginRoots: [], env: {} }, handle.fd)).rejects.toThrow()
  await handle.close()
  await expect.poll(async () => {
    try { await lease.assertStopped(); return true } catch { return false }
  }, { timeout: 2000 }).toBe(true)
})

it.runIf(process.platform === 'darwin')('stops only the exact orphan candidate holding fd 3', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  const entrypoint = join(profileRoot, 'candidate.mjs')
  await writeFile(entrypoint, 'setInterval(() => {}, 1000)')
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), process.getuid!())
  const handle = await lease.acquireForSpawn()
  const child = spawn(process.execPath, [entrypoint, '--profile', 'web', '--no-open',
    '--host', '127.0.0.1', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore', handle.fd] })
  const exited = once(child, 'exit')
  onTestFinished(async () => { child.kill('SIGKILL'); await rm(profileRoot, { recursive: true, force: true }) })
  await handle.close()
  await expect(lease.assertStopped()).rejects.toThrow('profile_import_candidate_running')
  let authorityChecks = 0
  await expect(lease.stopOrphan({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: entrypoint, assertAuthority: () => {
      if (++authorityChecks === 2) throw Error('host_authority_lost')
    } })).rejects.toThrow('host_authority_lost')
  expect(child.exitCode).toBeNull()
  expect(await lease.stopOrphan({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: entrypoint, assertAuthority: () => {} })).toBe(true)
  await exited
  await lease.assertStopped()
})

it.runIf(process.platform === 'darwin')('refuses to signal a different process holding the same witness', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  const entrypoint = join(profileRoot, 'candidate.mjs')
  await writeFile(entrypoint, 'setInterval(() => {}, 1000)')
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), process.getuid!())
  const handle = await lease.acquireForSpawn()
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'ignore', handle.fd] })
  onTestFinished(async () => { child.kill('SIGKILL'); await rm(profileRoot, { recursive: true, force: true }) })
  await handle.close()
  await expect(lease.stopOrphan({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: entrypoint, assertAuthority: () => {} }))
    .rejects.toThrow('profile_import_candidate_holder_unsafe')
  expect(child.exitCode).toBeNull()
  child.kill('SIGKILL')
  await once(child, 'exit')
})

it.runIf(process.platform === 'darwin')('requires authority before orphan inspection', async () => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-lease-'))
  onTestFinished(() => rm(profileRoot, { recursive: true, force: true }))
  const lease = new FileProfileImportCandidateLease(profileRoot, randomUUID(), process.getuid!())
  const handle = await lease.acquireForSpawn()
  await handle.close()
  const options = { nodeExecutablePath: process.execPath, dshEntrypointPath: '/unused',
    assertAuthority: () => { throw Error('host_authority_lost') } }
  await expect(lease.stopOrphan(options)).rejects.toThrow('host_authority_lost')
  await expect(lease.stopOrphan({ ...options, assertAuthority: () => {} })).resolves.toBe(false)
})
