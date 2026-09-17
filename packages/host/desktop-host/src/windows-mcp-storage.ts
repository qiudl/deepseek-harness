import { win32 } from 'node:path'
import type { ProfileMcpStorage } from './profile-mcp-storage.ts'
import { assertWindowsHostPrivatePathEvidence, windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings } from './windows-host-registration.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_PATCH_BYTES = 1_048_576

/** Windows MCP patch persistence; the caller holds the Host lease and resolves only authorized Profile roots. */
export class WindowsMcpStorage implements ProfileMcpStorage {
  private readonly securityDescriptor: string
  private readonly inspectDirectory: NonNullable<WindowsHostRegistrationFileBindings['inspectExistingDirectory']>
  private readonly createFile: NonNullable<WindowsHostRegistrationFileBindings['createPrivateFile']>
  private readonly removeFile: NonNullable<WindowsHostRegistrationFileBindings['removePrivateFile']>
  constructor(private readonly options: {
    profileRoot(profileId: string): string
    readonly userSid: string
    readonly bindings: WindowsHostRegistrationFileBindings
  }) {
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
    if (!options.bindings.inspectExistingDirectory || !options.bindings.createPrivateFile || !options.bindings.removePrivateFile) {
      throw Error('upgrade_required')
    }
    this.inspectDirectory = options.bindings.inspectExistingDirectory.bind(options.bindings)
    this.createFile = options.bindings.createPrivateFile.bind(options.bindings)
    this.removeFile = options.bindings.removePrivateFile.bind(options.bindings)
  }
  private directory(profileId: string): string {
    const root = this.options.profileRoot(profileId)
    if (!/^[A-Za-z]:\\/u.test(root) || /[\u0000-\u001f\u007f]/u.test(root)
      || root.slice(2).includes(':') || win32.normalize(root) !== root) throw Error('unsafe_profile')
    const web = win32.join(root, 'profiles', 'web')
    for (const path of [root, win32.join(root, 'profiles'), web]) {
      assertWindowsHostPrivatePathEvidence(this.inspectDirectory(path), 'directory', this.options.userSid)
    }
    return web
  }
  private read(path: string, maximumBytes: number): string | null {
    const file = this.options.bindings.readPrivateFile(path, maximumBytes)
    if (file === undefined) return null
    assertWindowsHostPrivatePathEvidence(file.evidence, 'file', this.options.userSid)
    if (file.contents.length > maximumBytes) throw Error('unsafe_patch')
    return UTF8.decode(file.contents)
  }
  snapshot(profileId: string): string | null {
    return this.read(win32.join(this.directory(profileId), 'cordis.patch.yml'), MAX_PATCH_BYTES)
  }
  private backupPath(profileId: string, operationId: string): string {
    if (!UUID.test(operationId)) throw Error('invalid_input')
    return win32.join(this.directory(profileId), `.mcp-before-${operationId}`)
  }
  backup(profileId: string, operationId: string, snapshot: string | null): void {
    const contents = Buffer.from(snapshot === null ? '0' : `1${snapshot}`)
    if (contents.length > MAX_PATCH_BYTES + 1) throw Error('unsafe_backup')
    const result = this.createFile(this.backupPath(profileId, operationId), contents, this.securityDescriptor)
    assertWindowsHostPrivatePathEvidence(result.evidence, 'file', this.options.userSid)
    if (result.state !== 'created') throw Error('backup_exists')
  }
  readBackup(profileId: string, operationId: string): string {
    const text = this.read(this.backupPath(profileId, operationId), MAX_PATCH_BYTES + 1)
    if (text === null || text.length === 0) throw Error('unsafe_backup')
    return text
  }
  publish(profileId: string, content: string | null, expected: string | null, guard: () => void): void {
    guard()
    const path = win32.join(this.directory(profileId), 'cordis.patch.yml')
    const contents = content === null ? null : Buffer.from(content)
    if (contents !== null && contents.length > MAX_PATCH_BYTES) throw Error('unsafe_patch')
    if (this.snapshot(profileId) !== expected) throw Error('revision_conflict')
    guard()
    if (contents === null) {
      if (expected !== null) this.removeFile(path, Buffer.from(expected), this.options.userSid, guard)
      return
    }
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.replacePrivateFile(path, contents, this.securityDescriptor), 'file', this.options.userSid,
    )
  }
}
