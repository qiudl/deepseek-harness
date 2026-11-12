/** REQ-20261022-0022: identity fields shared by every owner-private Profile import record. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/**
 * Require one operation UUID and two distinct Profile UUIDs.
 * @param row - Decoded owner-private record.
 * @returns whether the record's identity fields are well formed.
 */
export function validRecordIdentity(row: Readonly<Record<string, unknown>>): boolean {
  return typeof row.operationId === 'string' && UUID.test(row.operationId)
    && typeof row.sourceProfileId === 'string' && UUID.test(row.sourceProfileId)
    && typeof row.targetProfileId === 'string' && UUID.test(row.targetProfileId)
    && row.sourceProfileId !== row.targetProfileId
}
