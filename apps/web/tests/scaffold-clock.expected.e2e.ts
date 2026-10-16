import { expect, it } from 'vitest'
import { normalizeAria } from './scaffold.ts'

it.each([
  ['12:34', '{{clock}}'],
  ['10/16 12:34', '10/16 {{clock}}'],
  ['1/2 03:04', '1/2 {{clock}}'],
  ['2025-1-2 03:04', '2025-1-2 {{clock}}'],
  ['2026-01-01 08:00:00.001', '2026-01-01 {{clock}}'],
  ['10月16日 12:34', '{{clock}}'],
  ['2025年1月2日 03:04', '{{clock}}'],
])(
  'normalizes clocks while retaining recorded English dates: %s', (clock, expected) => {
    expect(normalizeAria(`- text: ${clock}`, '/workspace', false)).toBe(`- text: ${expected}`)
  },
)
