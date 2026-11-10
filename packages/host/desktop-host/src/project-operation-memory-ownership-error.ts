/** A failed close is not proof of released memory ownership; shutdown must retain outer ownership. */
export class ProjectMemoryOwnershipRetainedError extends Error {
  constructor(cause: unknown) {
    super('project_memory_ownership_retained', { cause })
  }
}
