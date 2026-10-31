import { expect, it } from 'vitest'
import { parseHostRemoteSessionJson } from '../src/index.ts'
it('detaches private worker records and applies existing Host JSON bounds', () => {
  const input = { kind: 'prepared', descriptor: { workspace_id: 'original' }, values: [1, true, null] }
  const parsed = parseHostRemoteSessionJson(input)
  input.descriptor.workspace_id = 'changed'
  expect(parsed).toEqual({ kind: 'prepared', descriptor: { workspace_id: 'original' }, values: [1, true, null] })
  for (const value of [
    NaN,
    { text: 'x'.repeat(32769) },
    { nodes: Array(257).fill(0) },
    JSON.parse('{"__proto__":{"private":true}}'),
  ])
    expect(() => parseHostRemoteSessionJson(value)).toThrow()
})
