import { win32 } from 'node:path'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

/** Stable-file hooks consumed by ProfileRegistry on Windows. */
export interface WindowsProfileRegistryFileAuthority {
  prepareRoot(root: string): void
  loadSnapshot(path: string): unknown
  persistSnapshot(path: string, root: string, snapshot: unknown): void
}

/** Bind Profile registry JSON to the same Windows private-root authority as Host registration. */
export function createWindowsProfileRegistryFileAuthority(options: {
  readonly root: string
  readonly userSid: string
  readonly maximumSnapshotBytes: number
  readonly bindings: WindowsHostRegistrationFileBindings
}): WindowsProfileRegistryFileAuthority {
  if (!Number.isSafeInteger(options.maximumSnapshotBytes) || options.maximumSnapshotBytes < 1) {
    throw new HostAuthorityError('invalid_input')
  }
  const path = win32.join(options.root, 'profiles.json')
  const securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
  const prepareRoot = (candidate: string): void => {
    if (candidate !== options.root) throw new HostAuthorityError('invalid_input')
    assertWindowsHostPrivatePathEvidence(
      options.bindings.ensurePrivateDirectory(candidate, securityDescriptor),
      'directory',
      options.userSid,
    )
  }
  return {
    prepareRoot,
    loadSnapshot(candidate) {
      if (candidate !== path) throw new HostAuthorityError('invalid_input')
      const file = options.bindings.readPrivateFile(candidate, options.maximumSnapshotBytes)
      if (file === undefined) return undefined
      assertWindowsHostPrivatePathEvidence(file.evidence, 'file', options.userSid)
      try {
        const parsed: unknown = JSON.parse(file.contents.toString('utf8'))
        return parsed
      } catch { throw new HostAuthorityError('unavailable') }
    },
    persistSnapshot(candidate, root, snapshot) {
      if (candidate !== path || root !== options.root) throw new HostAuthorityError('invalid_input')
      prepareRoot(root)
      const contents = Buffer.from(`${JSON.stringify(snapshot)}\n`)
      if (contents.length > options.maximumSnapshotBytes) throw new HostAuthorityError('unavailable')
      assertWindowsHostPrivatePathEvidence(
        options.bindings.replacePrivateFile(candidate, contents, securityDescriptor),
        'file',
        options.userSid,
      )
    },
  }
}
