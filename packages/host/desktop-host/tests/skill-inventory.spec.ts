import { expect, it } from 'vitest'
import { skillInventory } from '../src/skill-inventory.ts'
const local = { id: 'bundle-demo', name: 'demo', transport: 'markdown', model_invocable: true, user_invocable: false, path: '/profile/skills/demo/SKILL.md' }
const winner = { name: 'demo', source: 'user-dsh', path: local.path, invocation: { modelInvocable: true, userInvocable: false } }
it('joins effective local entries without leaking Host paths or duplicating winners', () => {
  const result = skillInventory([local], { complete: true, skills: [winner] })
  expect(result).toEqual([{ id: local.id, name: local.name, transport: 'markdown', model_invocable: true, user_invocable: false,
    skill_source: 'user-dsh', skill_status: 'effective' }])
})
it('retains shadowed locals alongside read-only winners and reports unobserved local definitions', () => {
  const result = skillInventory([local], { complete: true, skills: [{ ...winner, source: 'user-agents', path: '/private/agents/demo.md' }] })
  expect(result[0]).toMatchObject({ id: local.id, skill_status: 'shadowed', effective_source: 'user-agents' })
  expect(result[1]).toMatchObject({ skill_status: 'effective', skill_source: 'user-agents', user_invocable: false })
  expect(result[1]!.id).toMatch(/^catalog-[a-f0-9]{64}$/u)
  expect(JSON.stringify(result)).not.toContain('/private')
  expect(skillInventory([local], { complete: true, skills: [] })[0]).toMatchObject({ skill_status: 'not_visible' })
})
it.each([{ complete: false, skills: [] }, { complete: true, skills: [winner, winner] },
  { complete: true, skills: [{ ...winner, invocation: {} }] }])('rejects incomplete or malformed snapshots instead of showing an empty list', (catalog) => {
  expect(() => skillInventory([local], catalog)).toThrow()
})
