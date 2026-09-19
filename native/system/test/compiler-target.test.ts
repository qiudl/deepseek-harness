import assert from 'node:assert/strict'
import { test } from 'node:test'
import { darwinCompilerArchitecture } from '../scripts/compiler-target.js'

test('maps Node macOS architectures to explicit clang targets', () => {
  assert.equal(darwinCompilerArchitecture('arm64'), 'arm64')
  assert.equal(darwinCompilerArchitecture('x64'), 'x86_64')
  assert.throws(
    () => darwinCompilerArchitecture('ia32'),
    /unsupported macOS architecture ia32/,
  )
})
