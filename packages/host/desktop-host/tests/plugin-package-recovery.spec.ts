import { expect, it } from 'vitest'
import { validPluginPackageRecovery } from '../src/plugin-package-recovery.ts'

const intent = {
  action: 'install', packageName: 'fixture', spec: 'fixture@1.0.0',
  originalSpecDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), removedIds: [], stage: 'prepared',
}

it.each([
  ['action', ['install']], ['stage', ['prepared']],
])('rejects a persisted array masquerading as a %s string', (field, value) => {
  expect(validPluginPackageRecovery({ ...intent, [field]: value })).toBe(false)
})

it.each(['prepared', 'command_completed', 'verified'])('accepts a pinned intent at stage %s', (stage) => {
  expect(validPluginPackageRecovery({ ...intent, stage })).toBe(true)
  expect(validPluginPackageRecovery({ ...intent, action: 'update', stage })).toBe(true)
})
it('accepts scoped registry and immutable GitHub sources', () => {
  expect(validPluginPackageRecovery({ ...intent, packageName: '@scope/fixture', spec: '@scope/fixture@1.0.0' })).toBe(true)
  expect(validPluginPackageRecovery({ ...intent, spec: `github:owner/repo#${'a'.repeat(40)}` })).toBe(true)
})
it('accepts bounded removal identities without an installation spec', () => {
  const removal = { ...intent, action: 'remove', spec: undefined }
  expect(validPluginPackageRecovery({ ...removal, removedIds: Array.from({ length: 128 }, (_, i) => `include:${i}`) })).toBe(true)
  expect(validPluginPackageRecovery({ ...removal, removedIds: [`include:${'a'.repeat(248)}`] })).toBe(true)
})
it.each([null, false, 'intent', [], 1])('rejects a non-record receipt: %j', (value) => {
  expect(validPluginPackageRecovery(value)).toBe(false)
})
it.each([
  ['unknown field', { extra: true }], ['unknown action', { action: 'retry' }],
  ['non-string name', { packageName: 1 }], ['oversized name', { packageName: 'a'.repeat(215) }],
  ['invalid name', { packageName: '../fixture' }], ['missing spec', { spec: undefined }],
  ['mutable spec', { spec: 'fixture@latest' }], ['wrong package', { spec: 'other@1.0.0' }],
  ['spec on removal', { action: 'remove' }],
  ['non-string original digest', { originalSpecDigest: null }], ['invalid original digest', { originalSpecDigest: 'z'.repeat(64) }],
  ['non-string scope digest', { scopeDigest: [] }], ['invalid scope digest', { scopeDigest: 'short' }],
  ['non-array identities', { removedIds: {} }], ['installation with removed identities', { removedIds: ['include:tool'] }],
  ['unknown stage', { stage: 'finished' }],
])('rejects malformed persisted intent: %s', (_label, patch) => {
  expect(validPluginPackageRecovery({ ...intent, ...patch })).toBe(false)
})
it.each([
  [null], ['tool'], ['include:'], ['include:a', 'include:a'], ['include:line\nbreak'],
  [`include:${'a'.repeat(249)}`], [`include:${'界'.repeat(84)}`],
  Array.from({ length: 129 }, (_, i) => `include:${i}`),
])('rejects invalid or oversized removed entry identities: %j', (...removedIds) => {
  expect(validPluginPackageRecovery({ ...intent, action: 'remove', spec: undefined, removedIds })).toBe(false)
})
