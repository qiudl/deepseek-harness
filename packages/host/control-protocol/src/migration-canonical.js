import { createHash } from 'node:crypto';
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const record = value;
        return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
            .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        throw new Error('migration_canonical_non_json_value');
    }
    return JSON.stringify(value);
}
/**
 * Encode records after the fixed collection/id/sequence ordering.
 * @param records - semantic records from a quiesced persistence snapshot.
 * @returns canonical JSON used by both exporter and verifier.
 */
export function canonicalMigrationRecords(records) {
    const sorted = [...records].sort((left, right) => left.collection.localeCompare(right.collection, 'en')
        || left.id.localeCompare(right.id, 'en') || left.sequence - right.sequence);
    return canonicalJson(sorted);
}
/**
 * Compute the normative SHA-256 semantic snapshot digest.
 * @param records - semantic records from a quiesced persistence snapshot.
 * @returns lower-case SHA-256 hexadecimal digest.
 */
export function migrationSemanticDigest(records) {
    return createHash('sha256').update(canonicalMigrationRecords(records)).digest('hex');
}
/**
 * Bind one import journal to the Host-minted, connection-owned Profile lease.
 * @param selector - Host-signed Profile selector.
 * @returns lower-case SHA-256 selector digest.
 */
export function migrationProfileSelectorHash(selector) {
    return createHash('sha256').update(`dsh-migration-profile-selector-hash/v1\0${selector}`).digest('hex');
}
//# sourceMappingURL=migration-canonical.js.map