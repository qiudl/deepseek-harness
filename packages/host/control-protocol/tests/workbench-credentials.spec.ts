import assert from 'node:assert/strict'
import { it } from 'vitest'
import { parseWorkbenchCredentialWrite } from '../src/workbench-credentials.ts'
it('admits only one-way set/unset with bounded values and no storage selectors', () => {
  for (const value of [{ method: 'set', args: { ref: 'TEST_API_KEY', value: 'synthetic-value' } },
    { method: 'unset', args: { ref: '_TEST' } }]) assert.deepEqual(parseWorkbenchCredentialWrite(value), value)
  for (const value of [null, [], 1, {}, { method: 'set', args: null }, { method: 'set', args: [] },
    { method: 'set', args: {}, profile: 'other' },
    ...[{}, { ref: 1 }, { ref: 'bad-ref' }, { ref: 'a'.repeat(129) }, { ref: 'TEST', value: '' },
      { ref: 'TEST', value: null }, { ref: 'TEST', value: 'x'.repeat(16385) },
      { ref: 'TEST', value: 'x', file: '/tmp/other' }].map(args => ({ method: 'set', args })),
    { method: 'unset', args: { ref: 'TEST', value: 'x' } }, { method: 'read', args: { ref: 'TEST' } },
  ]) assert.equal(parseWorkbenchCredentialWrite(value), undefined)
})
