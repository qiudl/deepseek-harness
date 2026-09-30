/**
 * Require a decoded owner-state object while retaining its schema error.
 * @param value - decoded owner-state field.
 * @returns the validated object.
 */
export function migrationOwnerStateObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('migration_owner_state_invalid')
  }
  return value as Record<string, unknown>
}
