// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { createNativeMemoryStorage } from '../src/native-storage.ts'
it('keeps browser preferences only in bounded frame memory', () => {
  const storage = createNativeMemoryStorage(12)
  storage.setItem('key', 'draft')
  expect(storage.getItem('key')).toBe('draft')
  expect(storage.length).toBe(1)
  expect(storage.key(0)).toBe('key')
  expect(storage.key(1)).toBeNull()
  expect(() => { storage.setItem('large', '123456789') }).toThrow()
  expect(storage.getItem('key')).toBe('draft')
  storage.setItem('key', 'edit')
  expect(storage.length).toBe(1)
  storage.removeItem('key'); storage.removeItem('absent')
  expect(storage.getItem('key')).toBeNull()
  storage.setItem('a', 'b'); storage.clear()
  expect(storage.length).toBe(0)
  expect(createNativeMemoryStorage().getItem('a')).toBeNull()
})
