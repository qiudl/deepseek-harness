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

it.each([
  null, [], {}, { complete: true, skills: {} },
  { complete: true, skills: Array.from({ length: 129 }, () => winner) },
  ...[null, [], { ...winner, name: '../escape' }, { ...winner, name: 12 },
    { ...winner, name: 'a'.repeat(65) }, { ...winner, source: null },
    { ...winner, source: 'x'.repeat(257) }, { ...winner, invocation: null },
    { ...winner, invocation: { modelInvocable: 'true', userInvocable: false } },
    { ...winner, invocation: { modelInvocable: true, userInvocable: 1 } },
    { ...winner, path: 12 }, { ...winner, path: '/'.repeat(4097) },
  ].map(skill => ({ complete: true, skills: [skill] })),
])('rejects an untrusted catalog that violates the bounded metadata contract: %#', (catalog) => {
  expect(() => skillInventory([], catalog)).toThrow()
})

it('keeps unknown providers private and supports summaries without filesystem paths', () => {
  const result = skillInventory([local], { complete: true, skills: [{
    name: 'demo', source: 'private-provider-name', invocation: winner.invocation,
  }] })
  expect(result[0]).toMatchObject({ skill_status: 'shadowed', effective_source: 'other' })
  expect(result[1]).toMatchObject({ skill_source: 'other', skill_status: 'effective' })
  expect(JSON.stringify(result)).not.toContain('private-provider-name')
  expect(JSON.stringify(result)).not.toContain(local.path)
})

it('bounds the merged inventory even when both input lists separately fit', () => {
  const locals = Array.from({ length: 128 }, (_, index) => ({ ...local, id: `flat-item-${index}`, name: `item-${index}` }))
  expect(skillInventory(locals, { complete: true, skills: [] })).toHaveLength(128)
  expect(() => skillInventory(locals, { complete: true, skills: [winner] })).toThrow('skill_limit')
})
