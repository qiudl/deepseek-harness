import { expect, it } from 'vitest'
import { renderSkillFile } from '#hub-skills'
import { verifySkillRuntime } from '../src/skill-runtime-ack.ts'

const expected = { name: 'host-demo', description: 'Installed skill', body: '\nExecute only this version.\n',
  whenToUse: 'When requested', modelInvocable: true, userInvocable: false }
const markdown = renderSkillFile(expected)
const path = '/profile/skills/host-demo/SKILL.md'
const actual = { name: expected.name, description: expected.description, content: 'Execute only this version.',
  whenToUse: expected.whenToUse, path, source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: false } }

it('accepts the loaded Profile skill even when it is absent from the human command catalog', () => {
  expect(() => { verifySkillRuntime(path, markdown, actual) }).not.toThrow()
})
it.each([
  undefined, null, {}, { ...actual, path: '/other/skills/host-demo/SKILL.md' },
  { ...actual, source: 'project-dsh' }, { ...actual, content: 'An older version.' },
  { ...actual, description: 'An older description' }, { ...actual, name: 'other' },
  { ...actual, whenToUse: 'An older condition' }, { ...actual, invocation: { modelInvocable: true, userInvocable: true } },
])('rejects missing, shadowed or stale runtime observations %#', (observation) => {
  expect(() => { verifySkillRuntime(path, markdown, observation) }).toThrow('skill_runtime_mismatch')
})
