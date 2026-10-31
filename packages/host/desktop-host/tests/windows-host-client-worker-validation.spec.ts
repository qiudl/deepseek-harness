import { describe, expect, it } from 'vitest'
import { assertWindowsWorkerKeys, windowsWorkerRecord } from '../src/windows-host-client-worker-validation.ts'

function reject(): never { throw new Error('rejected') }

describe('Windows Host client Worker strict object validation', () => {
  it('accepts an object with exactly the requested keys', () => {
    const value = windowsWorkerRecord({ second: 2, first: 1 }, reject)
    expect(() => { assertWindowsWorkerKeys(value, ['first', 'second'], reject) }).not.toThrow()
  })

  it.each([undefined, null, [], 'object'])('rejects a non-record input: %j', (input) => {
    expect(() => windowsWorkerRecord(input, reject)).toThrow('rejected')
  })

  it('rejects missing, excess, and different keys', () => {
    expect(() => { assertWindowsWorkerKeys({ first: 1 }, ['first', 'second'], reject) }).toThrow('rejected')
    expect(() => { assertWindowsWorkerKeys({ first: 1, second: 2 }, ['first'], reject) }).toThrow('rejected')
    expect(() => { assertWindowsWorkerKeys({ first: 1 }, ['second'], reject) }).toThrow('rejected')
  })
})
