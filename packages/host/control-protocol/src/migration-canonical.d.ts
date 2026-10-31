/** Cross-repository digest input shared by DSH export and Slark verification. */
export interface CanonicalMigrationRecord {
    readonly collection: 'sessions' | 'session_events' | 'owner_settings' | 'owner_credentials' | 'owner_workspace' | 'owner_profile';
    readonly id: string;
    readonly sessionId?: string;
    readonly sequence: number;
    readonly payloadDigest: string;
}
/**
 * Encode records after the fixed collection/id/sequence ordering.
 * @param records - semantic records from a quiesced persistence snapshot.
 * @returns canonical JSON used by both exporter and verifier.
 */
export declare function canonicalMigrationRecords(records: readonly CanonicalMigrationRecord[]): string;
/**
 * Compute the normative SHA-256 semantic snapshot digest.
 * @param records - semantic records from a quiesced persistence snapshot.
 * @returns lower-case SHA-256 hexadecimal digest.
 */
export declare function migrationSemanticDigest(records: readonly CanonicalMigrationRecord[]): string;
/**
 * Bind one import journal to the Host-minted, connection-owned Profile lease.
 * @param selector - Host-signed Profile selector.
 * @returns lower-case SHA-256 selector digest.
 */
export declare function migrationProfileSelectorHash(selector: string): string;
//# sourceMappingURL=migration-canonical.d.ts.map