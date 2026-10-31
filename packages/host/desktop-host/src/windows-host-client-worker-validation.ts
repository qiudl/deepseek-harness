/** Decode one strict object while preserving the caller's protocol-specific error. */
export function windowsWorkerRecord(
  input: unknown,
  reject: () => never,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return reject()
  return input as Record<string, unknown>
}

/** Require an exact object shape while preserving the caller's protocol-specific error. */
export function assertWindowsWorkerKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
  reject: () => never,
): void {
  const actual = Object.keys(input).sort()
  const canonical = [...expected].sort()
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) reject()
}
