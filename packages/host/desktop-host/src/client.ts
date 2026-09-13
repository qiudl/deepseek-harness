/** Main-process-only Unix Host client artifact embedded by Slark Desktop. @module @deepseek-ai/dsh-slark-desktop-host/client */

export { UnixHostClient, discoverUnixHost } from './unix-transport.ts'
export type {
  UnixHostClientOptions,
  UnixHostDiscovery,
  UnixPeerAttestor,
  UnixPeerEvidence,
} from './unix-transport.ts'
export { discoverWindowsHost } from './windows-host-client.ts'
export { loadWindowsHostClientWorkerCancellation } from './windows-client-bun-cancellation.ts'
export { createWindowsLocalProfileStorage } from './windows-local-profile-storage.ts'
export type { WindowsHostClientOptions, WindowsHostDiscovery } from './windows-host-client.ts'
export type { ProfileOpenResult } from './types.ts'
export { canonicalMigrationRecords, migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
