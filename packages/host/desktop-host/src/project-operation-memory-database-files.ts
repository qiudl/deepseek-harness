import { ProjectMemoryOwnershipRetainedError } from './project-operation-memory-ownership-error.ts'
/** Private files and bootstrap publication owned by the same Host as the memory database. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { acquireSingleHostLock } from './single-instance.ts'
import { acquireWindowsSingleHostLock } from './windows-single-instance.ts'
import { createPosixTwinBindingReceiptFile, createWindowsTwinBindingReceiptFile } from './twin-binding-receipt-files.ts'
import type { TwinBindingReceiptFile } from './twin-binding-receipts.ts'
import { readOwnerPrivateFile, assertWindowsPrivateRoot } from './private-file-io.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

type Identity = Readonly<{ profileId: string; installationId: string; publicKey: string }>
type Marker = Readonly<{
  version: 1
  profileId: string
  installationId: string
  publicKeyDigest: string
  databaseId: string
  state: 'pending' | 'published'
  mainFileIdentity: string | null
}>
type Guard = { state: 'created' | 'existing'; inspect(): { byteLength: bigint; fileIdentity: string }; release(): void }
type PlatformFiles = {
  path: string
  marker: TwinBindingReceiptFile
  inventory(fresh: boolean): void
  acquire(mode: 'create_or_open' | 'existing', suffix: '' | '-wal' | '-shm' | '-journal'): Guard
  journalExists(): boolean
  removeEmptyJournal(guard: () => void): void
  assertOwner(this: void): void
  releaseOwner(): Promise<void>
}
const invalid = (): never => {
  throw new HostAuthorityError('unavailable')
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function marker(value: unknown, identity: Identity): Marker {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const r = value as { [key: string]: unknown }
  if (
    Object.keys(r).sort().join(',') !==
      'databaseId,installationId,mainFileIdentity,profileId,publicKeyDigest,state,version' ||
    r.version !== 1 ||
    r.profileId !== identity.profileId ||
    r.installationId !== identity.installationId ||
    r.publicKeyDigest !== createHash('sha256').update(identity.publicKey).digest('hex') ||
    typeof r.databaseId !== 'string' ||
    !UUID.test(r.databaseId) ||
    (r.state !== 'pending' && r.state !== 'published') ||
    (r.mainFileIdentity !== null &&
      (typeof r.mainFileIdentity !== 'string' || !/^[0-9]+:[0-9]+$/u.test(r.mainFileIdentity))) ||
    (r.state === 'published' && r.mainFileIdentity === null)
  )
    return invalid()
  return r as Marker
}

/** Nontransferable private-file owner; only these platform factories construct it. */
export class ProjectOperationMemoryDatabaseFiles {
  private closing = false
  private closed = false
  private constructor(
    private readonly platform: PlatformFiles,
    private snapshot: Marker,
    private readonly main: Guard,
    private readonly sidecars: readonly Guard[],
    readonly publicKey: string,
  ) {}
  get path(): string {
    return this.platform.path
  }
  get databaseId(): string {
    return this.snapshot.databaseId
  }
  get published(): boolean {
    return this.snapshot.state === 'published'
  }
  get identity(): Readonly<Pick<Marker, 'profileId' | 'installationId' | 'publicKeyDigest'>> {
    return {
      profileId: this.snapshot.profileId,
      installationId: this.snapshot.installationId,
      publicKeyDigest: this.snapshot.publicKeyDigest,
    }
  }
  /** Check held descriptors, file identities and the current single-writer lease before database use. */
  assertCurrent(): void {
    if (this.closing || this.closed) return invalid()
    this.platform.assertOwner()
    const main = this.main.inspect()
    if (
      main.fileIdentity !== this.snapshot.mainFileIdentity ||
      main.byteLength > 3n * 1024n * 1024n * 1024n ||
      (this.published && main.byteLength === 0n)
    )
      return invalid()
    for (const [i, sidecar] of this.sidecars.entries()) {
      const file = sidecar.inspect(),
        maximum = i === 0 ? 64n * 1024n * 1024n : 16n * 1024n * 1024n
      if (file.byteLength > maximum) return invalid()
    }
    if (this.published && this.platform.journalExists()) return invalid()
  }
  /** Seal a known pending bootstrap only after the database schema/identity transaction is durable. */
  publish(): void {
    this.assertCurrent()
    if (this.published) return
    if (this.main.inspect().byteLength === 0n) return invalid()
    if (this.platform.journalExists()) this.platform.removeEmptyJournal(() =>{  this.assertCurrent() })
    const next = { ...this.snapshot, state: 'published' as const }
    this.platform.marker.write(Buffer.from(JSON.stringify(next)), () =>{  this.assertCurrent() })
    this.snapshot = next
    this.assertCurrent()
  }
  /** Stop new use, then release sidecars before SQLite performs its normal close cleanup. */
  releaseSidecars(): void {
    this.closing = true
    for (const file of this.sidecars) file.release()
  }
  /** Release main/owner only after the caller confirmed SQLite has closed.
   * @returns Completion of the exact memory writer lease release.
   */
  async releaseAfterDatabaseClose(): Promise<void> {
    if (this.closed) return
    if (!this.closing) return invalid()
    this.main.release()
    await this.platform.releaseOwner()
    this.closed = true
  }
  private static async prepare(
    platform: PlatformFiles,
    identity: Identity,
  ): Promise<ProjectOperationMemoryDatabaseFiles> {
    const opened: Guard[] = []
    try {
      if (
        !UUID.test(identity.profileId) ||
        !UUID.test(identity.installationId) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(identity.publicKey)
      )
        return invalid()
      platform.assertOwner()
      const bytes = platform.marker.read()
      platform.inventory(bytes === undefined)
      let current: Marker
      if (bytes === undefined) {
        current = {
          version: 1,
          profileId: identity.profileId,
          installationId: identity.installationId,
          publicKeyDigest: createHash('sha256').update(identity.publicKey).digest('hex'),
          databaseId: randomUUID(),
          state: 'pending',
          mainFileIdentity: null,
        }
        platform.marker.write(Buffer.from(JSON.stringify(current)), platform.assertOwner)
      } else {
        if (bytes.length > 16384) return invalid()
        current = marker(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), identity)
        platform.marker.ensureDurable(bytes)
      }
      const main = platform.acquire(current.state === 'published' ? 'existing' : 'create_or_open', '')
      opened.push(main)
      const initial = main.inspect()
      if (
        (current.mainFileIdentity !== null && current.mainFileIdentity !== initial.fileIdentity) ||
        (current.state === 'published' && initial.byteLength === 0n) ||
        (current.mainFileIdentity === null && initial.byteLength !== 0n)
      )
        return invalid()
      if (current.mainFileIdentity === null) {
        current = { ...current, mainFileIdentity: initial.fileIdentity }
        platform.marker.write(Buffer.from(JSON.stringify(current)), platform.assertOwner)
      }
      if (current.state === 'published' && platform.journalExists()) return invalid()
      if (current.state === 'pending') {
        // SQLite may use a rollback journal while first switching a fresh database to WAL.
        const journal = platform.acquire('create_or_open', '-journal')
        opened.push(journal)
        try {
          if (journal.inspect().byteLength > 3n * 1024n * 1024n * 1024n) return invalid()
        } finally {
          journal.release()
        }
      }
      const sidecars: Guard[] = []
      for (const suffix of ['-wal', '-shm'] as const) {
        const file = platform.acquire('create_or_open', suffix)
        sidecars.push(file)
        opened.push(file)
      }
      const result = new ProjectOperationMemoryDatabaseFiles(platform, current, main, sidecars, identity.publicKey)
      result.assertCurrent()
      return result
    } catch (error) {
      // A release failure stops cleanup; never advertise ownership as released on an uncertain close.
      if (error instanceof ProjectMemoryOwnershipRetainedError) throw error
      try {
        for (const file of opened.slice(1)) file.release()
        opened[0]?.release()
        await platform.releaseOwner()
      } catch (closeError) {
        throw new ProjectMemoryOwnershipRetainedError(closeError)
      }
      throw error
    }
  }
  /** Acquire owner-private POSIX files and a separate exact-generation memory writer lease.
   * @param options - Host-derived root/legacy paths and actual process/installation identity.
   * @returns Held private files; no existing candidate JSON or published ledger is recreated.
   */
  static async posix(
    options: Identity & {
      root: string
      legacyRoots: readonly string[]
      uid: number
      pid: number
      processNonce: string
    },
  ): Promise<ProjectOperationMemoryDatabaseFiles> {
    if (!isAbsolute(options.root)) return invalid()
    const directory = () => {
      mkdirSync(options.root, { recursive: true, mode: 0o700 })
      const stat = lstatSync(options.root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== options.uid || (stat.mode & 0o077) !== 0)
        return invalid()
    }
    directory()
    const lease = await acquireSingleHostLock({
      root: join(options.root, 'writer'),
      uid: options.uid,
      pid: options.pid,
      processNonce: options.processNonce,
    })
    const path = join(options.root, 'memory.v1.sqlite'),
      assertOwner = () => {
        directory()
        lease.assertOwner()
      }
    const acquire = (mode: 'create_or_open' | 'existing', suffix: string): Guard => {
      assertOwner()
      const file = path + suffix
      let fd: number,
        state: 'created' | 'existing' = 'existing'
      try {
        fd =
          mode === 'existing'
            ? openSync(file, constants.O_RDWR | constants.O_NOFOLLOW)
            : openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        if (mode !== 'existing') state = 'created'
      } catch (error) {
        if (mode === 'existing' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW)
      }
      let released = false
      const inspect = () => {
        assertOwner()
        const held = fstatSync(fd, { bigint: true }),
          current = lstatSync(file, { bigint: true })
        if (
          !held.isFile() ||
          held.nlink !== 1n ||
          held.uid !== BigInt(options.uid) ||
          (held.mode & 0o077n) !== 0n ||
          current.dev !== held.dev ||
          current.ino !== held.ino ||
          current.isSymbolicLink()
        )
          return invalid()
        return { byteLength: held.size, fileIdentity: String(held.dev) + ':' + String(held.ino) }
      }
      try {
        inspect()
        if (state === 'created') {
          fsyncSync(fd)
          const parent = openSync(options.root, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            fsyncSync(parent)
          } finally {
            closeSync(parent)
          }
        }
        return {
          state,
          inspect,
          release() {
            if (released) return
            closeSync(fd)
            released = true
          },
        }
      } catch (error) {
        try {
          closeSync(fd)
        } catch (closeError) {
          throw new ProjectMemoryOwnershipRetainedError(closeError)
        }
        throw error
      }
    }
    let receipt: TwinBindingReceiptFile | undefined
    return this.prepare(
      {
        path,
        assertOwner,
        acquire,
        get marker() {
          return (receipt ??= createPosixTwinBindingReceiptFile(join(options.root, 'bootstrap'), options.uid))
        },
        inventory(fresh) {
          for (const root of options.legacyRoots) {
            if (
              readOwnerPrivateFile(
                join(root, 'receipts.v1.json'),
                options.uid,
                0,
                () => new HostAuthorityError('unavailable'),
              ) !== undefined
            )
              return invalid()
          }
          if (fresh && ['', '-wal', '-shm', '-journal'].some(suffix => exists(path + suffix))) return invalid()
        },
        journalExists: () => exists(path + '-journal'),
        removeEmptyJournal(guard) {
          const journal = acquire('existing', '-journal')
          try {
            if (journal.inspect().byteLength !== 0n) return invalid()
            guard()
            unlinkSync(path + '-journal')
          } finally {
            journal.release()
          }
        },
        releaseOwner: () => lease.release(),
      },
      options,
    )
  }
  /** Acquire exact SID/DACL metadata handles; no SQLite body is read by the native filesystem carrier.
   * @param options - Embedding-owned canonical Windows paths, native file authority and actual owner identity.
   * @returns Held main/WAL/SHM guards whose share modes permit SQLite and prevent deletion until shutdown.
   */
  static async windows(
    options: Identity & {
      root: string
      legacyRoots: readonly string[]
      userSid: string
      pid: number
      processNonce: string
      bindings: WindowsHostRegistrationFileBindings
    },
  ): Promise<ProjectOperationMemoryDatabaseFiles> {
    assertWindowsPrivateRoot(options.root)
    const native = options.bindings.acquirePrivateDatabaseFile
    if (!native) return invalid()
    const descriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
    const directory = () =>{
      assertWindowsHostPrivatePathEvidence(
        options.bindings.ensurePrivateDirectory(options.root, descriptor),
        'directory',
        options.userSid,
      ) }
    directory()
    const lease = acquireWindowsSingleHostLock({
      root: win32.join(options.root, 'writer'),
      userSid: options.userSid,
      pid: options.pid,
      processNonce: options.processNonce,
      bindings: options.bindings,
    })
    const path = win32.join(options.root, 'memory.v1.sqlite'),
      assertOwner = () => {
        directory()
        lease.assertOwner()
      }
    const acquire = (mode: 'create_or_open' | 'existing', suffix: string): Guard => {
      assertOwner()
      const file = native(path + suffix, descriptor, mode)
      const inspect = () => {
        assertOwner()
        const value = file.inspect()
        assertWindowsHostPrivatePathEvidence(value.evidence, 'file', options.userSid)
        return { byteLength: value.byteLength, fileIdentity: value.fileIdentity }
      }
      try {
        inspect()
        return { state: file.state, inspect, release: () =>{  file.release() } }
      } catch (error) {
        try {
          file.release()
        } catch (closeError) {
          throw new ProjectMemoryOwnershipRetainedError(closeError)
        }
        throw error
      }
    }
    const journalExists = () => {
      try {
        const journal = acquire('existing', '-journal')
        journal.release()
        return true
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'win32Code' in error &&
          (error.win32Code === 2 || error.win32Code === 3)
        )
          return false
        throw error
      }
    }
    let receipt: TwinBindingReceiptFile | undefined
    return this.prepare(
      {
        path,
        acquire,
        assertOwner,
        get marker() {
          return (receipt ??= createWindowsTwinBindingReceiptFile(
            win32.join(options.root, 'bootstrap'),
            options.userSid,
            options.bindings,
          ))
        },
        inventory(fresh) {
          for (const file of [
            ...options.legacyRoots.map(root => win32.join(root, 'receipts.v1.json')),
            ...(fresh ? ['', '-wal', '-shm', '-journal'].map(suffix => path + suffix) : []),
          ]) {
            if (options.bindings.readPrivateFile(file, 0) !== undefined) return invalid()
          }
        },
        journalExists,
        removeEmptyJournal(guard) {
          if (!options.bindings.removePrivateFile) return invalid()
          options.bindings.removePrivateFile(path + '-journal', Buffer.alloc(0), options.userSid, guard)
        },
        releaseOwner: () => {
          lease.release()
          return Promise.resolve()
        },
      },
      options,
    )
  }
}
