/** Metadata-only legacy-home observation; no Profile, migration, or file-creation authority. */
import { win32 } from 'node:path'
import { WindowsHostRegistrationNativeError } from './windows-host-registration-native.ts'
import type { WindowsHostRegistrationFileBindings } from './windows-host-registration.ts'

/** A point-in-time observation, never authorization to create a replacement or migrate data. */
export interface WindowsLegacySourcePresence {
  readonly observedState: 'absent' | 'present' | 'unknown'
  readonly migrationAdmitted: false
}

/**
 * Observe only the OS-selected user's .dsh directory and its ancestors, without content reads.
 * Existing empty directories remain present. Missing ancestors, failed native checks, and foreign
 * user-home ownership remain unknown. Handles close between reads: this is not a stable-tree
 * inventory, source fingerprint, ACL admission, or proof that absence persists until creation.
 * @param input - OS-selected user home/SID and trusted native directory inspector.
 * @returns Bounded metadata status with no local path or native error details.
 */
export function probeWindowsLegacySourcePresence(input: {
  readonly userProfile: string
  readonly userSid: string
  readonly bindings: Pick<WindowsHostRegistrationFileBindings, 'inspectExistingDirectory'>
}): WindowsLegacySourcePresence {
  const unknown = { observedState: 'unknown', migrationAdmitted: false } as const
  const path = input.userProfile
  const inspect = input.bindings.inspectExistingDirectory
  if (!inspect || !/^[A-Za-z]:\\/u.test(path) || path.length <= 3 || path.length > 4096
    || win32.normalize(path) !== path || path.endsWith('\\')
    || /[<>:"|?*\u0000-\u001f\u007f]/u.test(path.slice(2))
    || !/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u.test(input.userSid)) return unknown
  const parts = path.slice(3).split('\\')
  if (parts.length > 128 || parts.some(part => !part || /[. ]$/u.test(part)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) return unknown
  let current = path.slice(0, 3)
  const ancestors = [current]
  for (const part of parts) { current = win32.join(current, part); ancestors.push(current) }
  try {
    for (const ancestor of ancestors) {
      const evidence = inspect.call(input.bindings, ancestor)
      if (evidence.kind !== 'directory' || evidence.reparsePoint
        || (ancestor === path && evidence.ownerSid !== input.userSid)) return unknown
    }
  } catch { return unknown }
  try {
    const evidence = inspect.call(input.bindings, win32.join(path, '.dsh'))
    if (evidence.kind !== 'directory' || evidence.reparsePoint || evidence.ownerSid !== input.userSid) return unknown
    return { observedState: 'present', migrationAdmitted: false }
  } catch (error) {
    if (error instanceof WindowsHostRegistrationNativeError
      && error.api === 'CreateFileW' && error.win32Code === 2) {
      return { observedState: 'absent', migrationAdmitted: false }
    }
    return unknown
  }
}
