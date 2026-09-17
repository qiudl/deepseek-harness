import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const clientRoot = resolve('packages/client')
const owner = resolve(clientRoot, 'ui-primitives/src/clipboard.ts')

describe('client clipboard ownership', () => {
  it('keeps every direct Web Clipboard write in the shared facade', () => {
    const violations = sourceFiles(clientRoot)
      .filter(file => /navigator\.clipboard\s*\.\s*writeText/u.test(readFileSync(file, 'utf8')))
      .filter(file => file !== owner)
      .map(file => relative(clientRoot, file))
    expect(violations).toEqual([])
  })
})

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'lib' || entry.name === 'tests' ? [] : sourceFiles(path)
    return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : []
  })
}
