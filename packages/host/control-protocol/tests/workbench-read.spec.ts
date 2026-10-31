import assert from 'node:assert/strict'
import { it } from 'vitest'
import { parseWorkbenchReadPayload, parseWorkbenchChangesPayload } from '../src/workbench-read.ts'
const request = (endpoint: string, args: object) => ({ args: { endpoint, rpcId: 'rpc-1', args } })
const base = { workspaceFileScopeId: 'session-1', path: 'file.txt' }
it('accepts only exact file reads and canonicalizes optional ranges', () => {
  for (const value of [
    request('workspaceFiles/stat', base), request('workspaceFiles/list', { ...base, path: '' }),
    request('workspaceFiles/read', { ...base, range: {} }),
    request('workspaceFiles/read', { ...base, range: { offset: 1, limit: 50 } }),
    request('workspaceFiles/readBytes', { ...base, options: {} }),
    request('workspaceFiles/readBytes', { ...base, options: { baseFile: '/tmp/image.png', range: { offset: 0, length: 2048 } } }),
    request('workspaceFiles/readBytes', { ...base, options: { range: {} } }),
  ]) assert.deepEqual(parseWorkbenchReadPayload(value), value)
})
it('rejects selectors, mutations, unsafe ranges, non-JSON shapes and overlong paths', () => {
  for (const value of [
    null, [], {}, { args: null }, { args: [] }, { args: {}, computerId: 'other' },
    { args: { endpoint: 'workspaceFiles/stat', rpcId: 1, args: base } },
    { args: { endpoint: 'workspaceFiles/stat', rpcId: 'bad\n', args: base } },
    { args: { endpoint: 'workspaceFiles/stat', rpcId: 'r'.repeat(129), args: base } },
    { args: { endpoint: 'workspaceFiles/stat', rpcId: 'rpc-1', args: null } },
    { args: { endpoint: 'workspaceFiles/stat', rpcId: 'rpc-1', args: base, token: 'x' } },
    request('settings/update', base), request('workspaceFiles/stat?all', base), request('workspaceFiles/write', base),
    ...[{}, { ...base, workspaceFileScopeId: 1 }, { ...base, workspaceFileScopeId: '../other' },
      { ...base, path: null }, { ...base, path: 'a\0b' }, { ...base, path: 'a'.repeat(4097) },
      { ...base, profileId: 'other' }].map(args => request('workspaceFiles/stat', args)),
    ...[null, [], { extra: 1 }, { offset: 0 }, { offset: 1.5 }, { offset: undefined }, { offset: '1' },
      { limit: 0 }, { limit: -1 }, { limit: Infinity }, { limit: Number.MAX_SAFE_INTEGER + 1 }]
      .map(range => request('workspaceFiles/read', { ...base, range })),
    ...[null, [], { extra: 1 }, { baseFile: null }, { baseFile: 'x\0y' }, { range: null },
      { range: [] }, { range: { extra: 1 } }, { range: { offset: -1 } }, { range: { offset: '0' } },
      { range: { length: 0 } }, { range: { length: 1.5 } }]
      .map(options => request('workspaceFiles/readBytes', { ...base, options })),
  ]) assert.equal(parseWorkbenchReadPayload(value), undefined, JSON.stringify(value))
})

it('admits only exact file observation coordinates', () => {
  const payload = { args: base }
  assert.deepEqual(parseWorkbenchChangesPayload(payload), payload)
  for (const value of [null, [], {}, { args: base, profileId: 'other' }, { args: {} },
    { args: { ...base, token: 'other' } }, { args: { ...base, workspaceFileScopeId: '../other' } }]) {
    assert.equal(parseWorkbenchChangesPayload(value), undefined)
  }
})
