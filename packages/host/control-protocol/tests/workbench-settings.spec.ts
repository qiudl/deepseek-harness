import assert from 'node:assert/strict'
import { it } from 'vitest'
import { parseWorkbenchSettingsWrite } from '../src/workbench-settings.ts'
const update = (args: object) => ({ method: 'update', args })
it('preserves exact settings intents, detaches values, and retains optimistic revision', () => {
  for (const value of [update({ ns: 'general', patch: { locale: 'zh', count: 1, unset: null, enabled: true, tags: ['a'] } }),
    { method: 'replace', args: { ns: 'general', section: {}, expectedRevision: 0 } },
    { method: 'mutate', args: { ns: 'general', ops: [{ op: 'set', path: ['locale'], value: 'en' }, { op: 'unset', path: [] }], expectedRevision: 4 } }]) {
    const result = parseWorkbenchSettingsWrite(value)
    assert.deepEqual(result, value)
    assert.notEqual(result?.args, value.args)
  }
})
it('rejects injected scope, oversized/deep values and invalid mutation or revision shapes', () => {
  let deep: unknown = 0
  for (let n = 0; n < 12; n++) deep = { value: deep }
  const valid = { ns: 'general', patch: {} }
  for (const value of [null, [], {}, { method: 'update', args: null }, { ...update(valid), profile: 'other' },
    { method: 'openSettingsDocument', args: valid },
    ...[{}, { ...valid, ns: '' }, { ...valid, ns: 1 }, { ...valid, ns: 'n'.repeat(257) }, { ...valid, ns: 'bad\n' },
      { ...valid, profile: 'other' }, { ...valid, patch: [] }, { ...valid, patch: { value: undefined } },
      { ...valid, patch: { value: Infinity } }, { ...valid, patch: { value: () => {} } },
      { ...valid, patch: { ['__proto__']: 'bad' } }, { ...valid, patch: { value: deep } },
      { ...valid, patch: { value: 'x'.repeat(32768) } },
      ...[null, undefined, -1, 0.5, '0', true, Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => ({ ...valid, expectedRevision }))].map(update),
    ...[null, Array(257).fill({ op: 'unset', path: [] }), [null], [{ op: 'set', path: [] }],
      [{ op: 'other', path: [] }], [{ op: 'unset', path: [], value: 0 }], [{ op: 'unset', path: 'key' }],
      [{ op: 'unset', path: Array(33).fill('key') }], [{ op: 'unset', path: [0] }],
      [{ op: 'unset', path: ['x'.repeat(257)] }], [{ op: 'unset', path: ['__proto__'] }]]
      .map(ops => ({ method: 'mutate', args: { ns: 'general', ops } })),
  ]) assert.equal(parseWorkbenchSettingsWrite(value), undefined)
})
