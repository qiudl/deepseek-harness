import { parseSkillFile } from '#hub-skills'

/**
 * Check a worker registry observation against the published Profile skill.
 * @param expectedPath Canonical Host-owned instruction path.
 * @param markdown Published Markdown rendered by the pinned Hub codec.
 * @param observation Invocation-neutral registry definition from the selected preset scope.
 * @returns Nothing when the effective definition matches; rejects missing, shadowed or stale observations.
 */
export function verifySkillRuntime(expectedPath: string, markdown: string, observation: unknown): void {
  const expected = parseSkillFile(markdown)
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) throw new Error('skill_runtime_mismatch')
  const actual = observation as Record<string, unknown>
  const invocation = actual.invocation
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) throw new Error('skill_runtime_mismatch')
  const policy = invocation as Record<string, unknown>
  if (actual.path !== expectedPath || actual.source !== 'user-dsh'
    || actual.name !== expected.meta.name || actual.description !== expected.meta.description
    || actual.whenToUse !== expected.meta.whenToUse || actual.content !== expected.body.trim()
    || policy.modelInvocable !== (expected.meta['disable-model-invocation'] !== true)
    || policy.userInvocable !== (expected.meta['user-invocable'] !== false)) throw new Error('skill_runtime_mismatch')
}
