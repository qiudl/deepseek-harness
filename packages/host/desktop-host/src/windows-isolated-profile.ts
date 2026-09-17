import { win32 } from 'node:path'
import {
  assertWindowsHostPrivatePathEvidence,
  describeWindowsHostPrivatePathObjectRejection,
  describeWindowsHostPrivatePathShapeRejection,
  windowsHostPrivateSecurityDescriptor,
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
  readonly tempRoot: string
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
  const tempRoot = win32.join(profileRoot, 'temp')
  const pluginsRoot = win32.join(profileRoot, 'plugins')
  const ownerStateRoot = win32.join(profileRoot, 'owner-state')
  const storageRoot = win32.join(ownerStateRoot, 'storages')
  const webRoot = win32.join(profileRoot, 'profiles', 'web')
  for (const path of [
    root,
    win32.join(root, 'profiles'),
    profileRoot,
    persistenceRoot,
    tempRoot,
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
    if (file.contents.length > maximumBytes) {
      throw new HostAuthorityError('unavailable',
        { cause: new Error(`managed file exceeds the size limit: ${file.path}`) })
    }
    const result = options.bindings.createPrivateFile(file.path, file.contents, securityDescriptor)
    if (result.state === 'created') {
      assertWindowsHostPrivatePathEvidence(result.evidence, 'file', options.userSid)
      continue
    }
    const existing = options.bindings.readPrivateFile(file.path, maximumBytes)
    if (existing === undefined) {
      throw new HostAuthorityError('unavailable',
        { cause: new Error(`an existing managed file could not be read back: ${file.path}`) })
    }
    if (existing.contents.length > maximumBytes) {
      throw new HostAuthorityError('unavailable',
        { cause: new Error(`an existing managed file exceeds the size limit: ${file.path}`) })
    }
    // A Profile writer replaces these files through its own rename, so the replacement carries
    // inherited entries under its own token's default owner. Windows keeps a creation-time
    // descriptor only for CreateFileW and normalizes inheritance flags away on every later
    // SetSecurityInfo, so such a file can never be repaired in place; republishing it through the
    // same write-through path is the only way back. Only the descriptor shape is recoverable: a
    // reparse point, a hard link or any foreign access still fails closed, because republishing
    // would launder an object this Host never created into a trusted one.
    const objectRejection = describeWindowsHostPrivatePathObjectRejection(
      existing.evidence, 'file', options.userSid)
    if (objectRejection !== undefined) {
      throw new HostAuthorityError('unavailable', { cause: new Error(objectRejection) })
    }
    const evidence = describeWindowsHostPrivatePathShapeRejection(existing.evidence, options.userSid) === undefined
      ? existing.evidence
      : options.bindings.replacePrivateFile(file.path, existing.contents, securityDescriptor)
    assertWindowsHostPrivatePathEvidence(evidence, 'file', options.userSid)
    if (!file.mutable && !existing.contents.equals(file.contents)) throw new HostAuthorityError('conflict')
  }
  return { profileRoot, persistenceRoot, tempRoot, pluginRoots: [pluginsRoot], persistenceGeneration: 1 }
}
