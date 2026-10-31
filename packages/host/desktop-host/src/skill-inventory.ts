import { createHash } from 'node:crypto'

/** Sources safe to expose outside Host; provider names and paths remain private. */
export type SkillInventorySource = 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other'
/** A local definition or a winning default-preset definition. */
export interface SkillInventoryEntry {
  id: string
  name: string
  transport: string
  model_invocable: boolean
  user_invocable: boolean
  skill_source?: SkillInventorySource
  skill_status?: 'effective' | 'shadowed' | 'not_visible'
  effective_source?: SkillInventorySource
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function source(value: string): SkillInventorySource {
  return ['user-dsh', 'user-agents', 'custom', 'bundled', 'runtime'].includes(value) ? value as SkillInventorySource : 'other'
}
/**
 * Join owned local definitions with invocation-neutral winning summaries.
 * @param local Local entries with Host-private absolute paths.
 * @param catalog Untrusted worker snapshot; incomplete observations are rejected.
 * @returns Bounded metadata without paths, provider identifiers, or instruction bodies.
 */
export function skillInventory(local: readonly (SkillInventoryEntry & { path: string })[], catalog: unknown): SkillInventoryEntry[] {
  if (!record(catalog) || catalog.complete !== true || !Array.isArray(catalog.skills) || catalog.skills.length > 128) throw Error('skill_catalog_unavailable')
  const winners = new Map<string, { name: string; source: string; path?: string; model: boolean; user: boolean }>()
  for (const skill of catalog.skills) {
    if (!record(skill) || typeof skill.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name) || skill.name.length > 64
      || typeof skill.source !== 'string' || skill.source.length > 256 || !record(skill.invocation)
      || typeof skill.invocation.modelInvocable !== 'boolean' || typeof skill.invocation.userInvocable !== 'boolean'
      || (skill.path !== undefined && (typeof skill.path !== 'string' || skill.path.length > 4096)) || winners.has(skill.name)) throw Error('invalid_skill_catalog')
    winners.set(skill.name, { name: skill.name, source: skill.source, ...(skill.path === undefined ? {} : { path: skill.path }),
      model: skill.invocation.modelInvocable, user: skill.invocation.userInvocable })
  }
  const matched = new Set<string>()
  const entries: SkillInventoryEntry[] = local.map(({ path, ...entry }) => {
    const winner = winners.get(entry.name)
    const effective = winner?.source === 'user-dsh' && winner.path === path
    if (effective) matched.add(entry.name)
    return { ...entry, skill_source: 'user-dsh', skill_status: effective ? 'effective' : winner ? 'shadowed' : 'not_visible',
      ...(winner && !effective ? { effective_source: source(winner.source) } : {}) }
  })
  for (const winner of winners.values()) {
    if (matched.has(winner.name)) continue
    entries.push({ id: `catalog-${createHash('sha256').update(JSON.stringify([winner.name, winner.source, winner.path])).digest('hex')}`,
      name: winner.name, transport: 'markdown', model_invocable: winner.model, user_invocable: winner.user,
      skill_source: source(winner.source), skill_status: 'effective' })
  }
  if (entries.length > 128) throw Error('skill_limit')
  return entries
}
