import { expect, it } from 'vitest'
import { botBoundedVisible } from '../src/bot-value-shape.ts'

it('rejects control characters in bounded Bot protocol strings', () => {
  expect(botBoundedVisible('visible', 16)).toBe(true)
  expect(botBoundedVisible('line\nfeed', 16)).toBe(false)
  expect(botBoundedVisible('delete\u007f', 16)).toBe(false)
})
