import { createHash } from 'node:crypto'
import { HostAuthorityError } from './types.ts'

const INSTALLATION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const USER_SID = new RegExp(
  String.raw`^(?:S-1-5-21-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)`+
    String.raw`|S-1-12-1-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*))$`,
  'u',
)

const PIPE_ACCESS_DUPLEX = 0x0000_0003
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x0008_0000
const PIPE_REJECT_REMOTE_CLIENTS = 0x0000_0008

/** Return whether a SID is a regular local/domain or Microsoft Entra user identity. */
export function isWindowsDshUserSid(value: string): boolean {
  return USER_SID.test(value)
}

/** Fixed native creation policy for the single local Windows Host pipe. */
export interface WindowsNamedPipePolicy {
  readonly path: string
  readonly securityDescriptor: string
  readonly openMode: number
  readonly pipeMode: number
  readonly maxInstances: 1
}

/**
 * Derive the opaque Windows pipe name owned by one registered DSH installation.
 * @param input - Exact installation and endpoint registration identities.
 * @returns A stable local pipe path that discloses neither identity.
 */
export function windowsNamedPipePath(input: {
  installationId: string
  endpointRegistrationId: string
}): string {
  if (!INSTALLATION_ID.test(input.installationId) || !UUID.test(input.endpointRegistrationId)) {
    throw new HostAuthorityError('invalid_input')
  }
  const digest = createHash('sha256')
    .update(`dsh-windows-named-pipe/v1\0${input.installationId}\0${input.endpointRegistrationId}`)
    .digest('hex')
  return String.raw`\\.\pipe\slark-dsh-host-v1-${digest}`
}

/**
 * Build the protected current-user DACL and non-remote pipe creation flags.
 * @param input - Registered installation identities and the current process token user SID.
 * @returns Exact values for one first-instance, duplex, local-only native pipe.
 */
export function resolveWindowsNamedPipePolicy(input: {
  installationId: string
  endpointRegistrationId: string
  userSid: string
}): WindowsNamedPipePolicy {
  if (!isWindowsDshUserSid(input.userSid)) throw new HostAuthorityError('invalid_input')
  return Object.freeze({
    path: windowsNamedPipePath(input),
    securityDescriptor: `O:${input.userSid}D:P(A;;GRGW;;;${input.userSid})`,
    openMode: PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    pipeMode: PIPE_REJECT_REMOTE_CLIENTS,
    maxInstances: 1,
  })
}
