import { win32 } from 'node:path'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostPrivatePathEvidence,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Paths for one new local Profile that is independent of every legacy migration source. */
export interface WindowsIsolatedProfile {
  readonly profileRoot: string
  readonly persistenceRoot: string
  readonly pluginRoots: readonly string[]
  readonly persistenceGeneration: 1
}

function checkedRoot(path: string): string {
  if (!DRIVE_ROOTED_PATH.test(path) || CONTROL_CHARACTER.test(path)
    || path.slice(2).includes(':') || win32.normalize(path) !== path) {
    throw new HostAuthorityError('invalid_input')
  }
  return path
}

const FULL_CONTROL = 0x1F01FF
const LOCAL_SYSTEM_SID = 'S-1-5-18'
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'

/**
 * Verify one existing worker-mutable Profile document after the owning worker rewrote it.
 * The worker replaces mutable documents atomically, so the replacement inherits the DACL of its
 * just-verified private parent directories instead of carrying an explicit protected descriptor.
 * Ownership, non-reparse, single-link, and the exact allow-FA principal set still must hold.
 * @param evidence - Handle-derived facts about the existing file.
 * @param userSid - Expected owner and private DACL principal.
 */
function assertWindowsWorkerMutableFileEvidence(
  evidence: WindowsHostPrivatePathEvidence, userSid: string,
): void {
  if (evidence.kind !== 'file' || evidence.reparsePoint || evidence.linkCount !== 1
    || evidence.ownerSid !== userSid || evidence.access.length !== 3) {
    throw new HostAuthorityError('unavailable')
  }
  const expected = new Set([userSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID])
  for (const entry of evidence.access) {
    if (entry.type !== 'allow' || entry.mask !== FULL_CONTROL || !expected.delete(entry.sid)) {
      throw new HostAuthorityError('unavailable')
    }
  }
  if (expected.size !== 0) throw new HostAuthorityError('unavailable')
}

/**
 * Create missing files for a fresh Windows Profile and preserve all safe files on retry.
 * This authority has no legacy-source path, so fallback cannot mutate or impersonate migration.
 */
export function prepareWindowsIsolatedProfile(options: {
  readonly root: string
  readonly profileId: string
  readonly userSid: string
  readonly maximumManagedFileBytes: number
  /** Prepare private web patch storage before CLI initialization when MCP execution is enabled. */
  readonly prepareMcpStorage?: boolean
  readonly bindings: WindowsHostRegistrationFileBindings
}): WindowsIsolatedProfile {
  const root = checkedRoot(options.root)
  if (!UUID.test(options.profileId)
    || !Number.isSafeInteger(options.maximumManagedFileBytes)
    || options.maximumManagedFileBytes < 1
    || options.bindings.createPrivateFile === undefined) {
    throw new HostAuthorityError('invalid_input')
  }
  const securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
  const profileRoot = win32.join(root, 'profiles', options.profileId)
  const persistenceRoot = win32.join(profileRoot, 'persistence')
  const pluginsRoot = win32.join(profileRoot, 'plugins')
  const ownerStateRoot = win32.join(profileRoot, 'owner-state')
  const storageRoot = win32.join(ownerStateRoot, 'storages')
  const webRoot = win32.join(profileRoot, 'profiles', 'web')
  for (const path of [
    root,
    win32.join(root, 'profiles'),
    profileRoot,
    persistenceRoot,
    pluginsRoot,
    ownerStateRoot,
    storageRoot,
    ...(options.prepareMcpStorage ? [win32.join(profileRoot, 'profiles'), webRoot] : []),
  ]) {
    assertWindowsHostPrivatePathEvidence(
      options.bindings.ensurePrivateDirectory(path, securityDescriptor),
      'directory',
      options.userSid,
    )
  }

  const patch = [
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${JSON.stringify(persistenceRoot)}`,
    '    compression: none',
    '- id: storage-json',
    '  config:',
    `    root: ${JSON.stringify(storageRoot)}`,
    '- id: settings',
    '  config:',
    `    path: ${JSON.stringify(win32.join(ownerStateRoot, 'settings.yaml'))}`,
    `    dshHome: ${JSON.stringify(profileRoot)}`,
    '    watch: false',
    '- id: credentials',
    '  config:',
    `    path: ${JSON.stringify(win32.join(ownerStateRoot, '.credentials.yaml'))}`,
    `    dshHome: ${JSON.stringify(profileRoot)}`,
    '    watch: false',
    '',
  ].join('\n')
  const files = [
    { path: win32.join(ownerStateRoot, 'settings.yaml'), contents: Buffer.from('{}\n'), mutable: true },
    {
      path: win32.join(ownerStateRoot, '.credentials.yaml'),
      contents: Buffer.from('{"version":1,"refs":{},"records":{}}\n'),
      mutable: true,
    },
    {
      path: win32.join(ownerStateRoot, 'profile.json'),
      contents: Buffer.from('{"name":"web","customPlugins":[]}\n'),
      mutable: true,
    },
    {
      path: win32.join(storageRoot, 'workspace.json'),
      contents: Buffer.from('{"unit":{"name":"workspace","version":2},"global":{"initialized":false,"workspaceIds":[],"archivedSessionIds":[]},"tables":{"workspaces":{}}}\n'),
      mutable: true,
    },
    { path: win32.join(profileRoot, 'cordis.patch.yml'), contents: Buffer.from(patch), mutable: false },
    ...(options.prepareMcpStorage ? [{ path: win32.join(webRoot, 'cordis.patch.yml'),
      contents: Buffer.from('[]\n'), mutable: true, maximumBytes: 1_048_576 }] : []),
  ]
  for (const file of files) {
    const maximumBytes = file.maximumBytes ?? options.maximumManagedFileBytes
    if (file.contents.length > maximumBytes) throw new HostAuthorityError('unavailable')
    const result = options.bindings.createPrivateFile(file.path, file.contents, securityDescriptor)
    if (result.state === 'created') {
      assertWindowsHostPrivatePathEvidence(result.evidence, 'file', options.userSid)
      continue
    }
    const existing = options.bindings.readPrivateFile(file.path, maximumBytes)
    if (existing === undefined) throw new HostAuthorityError('unavailable')
    if (existing.contents.length > maximumBytes) throw new HostAuthorityError('unavailable')
    if (file.mutable) {
      // The owning worker replaces its mutable documents atomically; the replacement inherits the
      // private DACL from the directories verified above rather than restating it explicitly.
      assertWindowsWorkerMutableFileEvidence(existing.evidence, options.userSid)
      continue
    }
    assertWindowsHostPrivatePathEvidence(existing.evidence, 'file', options.userSid)
    if (!existing.contents.equals(file.contents)) throw new HostAuthorityError('conflict')
  }
  return { profileRoot, persistenceRoot, pluginRoots: [pluginsRoot], persistenceGeneration: 1 }
}
