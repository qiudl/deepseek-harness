/** Main-process-only Unix Host client artifact embedded by Slark Desktop. @module @deepseek-ai/dsh-desktop-host/client */

export { UnixHostClient, discoverUnixHost } from './unix-transport.ts'
export type {
  UnixHostClientOptions,
  UnixHostDiscovery,
  UnixPeerAttestor,
  UnixPeerEvidence,
} from './unix-transport.ts'
export type { ProfileOpenResult } from './types.ts'
export { canonicalMigrationRecords, migrationSemanticDigest } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
