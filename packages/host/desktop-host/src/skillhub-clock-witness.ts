import type { HostSkillHubClockWitnessCommand, HostSkillHubClockWitnessValue } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

/** Independent Host-lifetime checkpoint witnesses; disconnect never removes an anchor. */
export class SkillHubClockWitnesses {
  private readonly values = new Map<string, HostSkillHubClockWitnessValue>()

  /** Read or advance a witness under the caller's already verified Profile scope.
   * @param scope - Current Profile, binding generation and installation key.
   * @param anchorId - Online-issued anchor UUID.
   * @param command - Exact revision CAS or read.
   * @returns Current value and null for a read, or the CAS verdict.
   */
  apply(scope: string, anchorId: string, command: HostSkillHubClockWitnessCommand): {
    value: HostSkillHubClockWitnessValue | null
    applied: boolean | null
  } {
    const key = JSON.stringify([scope, anchorId]), current = this.values.get(key) ?? null
    if (command.kind === 'read') return { value: current && { ...current }, applied: null }
    const previous = command.previous
    if ((current === null) !== (previous === null)
      || (current && previous && (current.revision !== previous.revision || current.digest !== previous.digest))
      || command.next.revision !== (previous ? BigInt(previous.revision) + 1n : 0n).toString())
      return { value: current && { ...current }, applied: false }
    // Capacity is a security bound. Eviction could turn a previous anchor into a new one.
    if (!current && this.values.size >= 4096) throw new HostAuthorityError('busy')
    this.values.set(key, { ...command.next })
    return { value: { ...command.next }, applied: true }
  }
}
