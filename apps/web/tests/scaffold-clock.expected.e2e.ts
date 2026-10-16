import { expect, it } from 'vitest'
import { normalizeAria } from './scaffold.ts'

it.each(['12:34', '10/16 12:34', '1/2 03:04', '2025-1-2 03:04', '10月16日 12:34', '2025年1月2日 03:04'])(
  'normalizes a rendered message clock across calendar boundaries: %s', (clock) => {
    expect(normalizeAria(`- text: ${clock}`, '/workspace', false)).toBe('- text: {{clock}}')
  },
)
