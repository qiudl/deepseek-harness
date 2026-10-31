/**
 * Strict, zero-I/O wire contract between the DSH Host supervisor and a local
 * Desktop broker. Transport ownership and authorization policy live elsewhere.
 * @module @deepseek-ai/dsh-host-control-protocol
 */
export { HOST_CONTROL_MAX_FRAME_BYTES, HostControlProtocolError, decodeHostControlFrame, encodeHostControlFrame, encodeHostInspectSignaturePayload, } from "./codec.js";
export { canonicalMigrationRecords, migrationProfileSelectorHash, migrationSemanticDigest } from "./migration-canonical.js";
//# sourceMappingURL=index.js.map