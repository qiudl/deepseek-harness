import { expect, it } from 'vitest'
import {
  parseHostPrivateTwinCommand, parseHostPrivateTwinResult, PRIVATE_TWIN_CONTROL_CHUNK_BYTES,
  PRIVATE_TWIN_CONTROL_REQUEST_BYTES,
} from '../src/index.ts'

const ticket = Buffer.alloc(32, 47).toString('base64url')
const profile_id = 'b3eeeaf0-6d61-4f7c-a6ad-feccae862c10'
const digest = 'a'.repeat(64)

it('validates exact private twin commands and bounded upload fragments', () => {
  const finish = { operation: 'finish', ticket, offset: 1, total_bytes: 2, digest, bytes: 'YQ' }
  expect(parseHostPrivateTwinCommand({ operation: 'claim' })).toEqual({ operation: 'claim' })
  expect(parseHostPrivateTwinCommand(finish)).toEqual(finish)
  for (const value of [
    null, [], { operation: 'other' }, { operation: 'claim', [Symbol()]: 'extra' },
    Object.defineProperty({ operation: 'claim' }, 'ticket', { get() { throw Error('untrusted getter') } }),
    { operation: 'check', ticket: 'YQ' }, { operation: 'check', ticket: '!' },
    { operation: 'read', ticket, offset: -1 }, { operation: 'read', ticket, offset: PRIVATE_TWIN_CONTROL_REQUEST_BYTES },
    { ...finish, digest: 'B'.repeat(64) }, { ...finish, offset: finish.total_bytes },
    { ...finish, bytes: 'YWI' }, { ...finish, bytes: 'YQ=' }, { ...finish, bytes: '' },
    { ...finish, bytes: Buffer.alloc(PRIVATE_TWIN_CONTROL_CHUNK_BYTES + 1).toString('base64url') },
  ]) expect(() => parseHostPrivateTwinCommand(value)).toThrow('invalid_host_private_twin_frame')
})

it('validates idle, claim and exact progress states without trusting result coordinates', () => {
  const claimed = { state: 'claimed', profile_id, ticket, total_bytes: 1, digest }
  expect(parseHostPrivateTwinResult({ state: 'idle' })).toEqual({ state: 'idle' })
  expect(parseHostPrivateTwinResult(claimed)).toEqual(claimed)
  for (const state of ['current', 'completed']) expect(parseHostPrivateTwinResult({ state, ticket })).toEqual({ state, ticket })
  for (const value of [
    { state: 'unrecognized' }, { state: 'idle', ticket }, { ...claimed, profile_id: 'unknown' },
    { ...claimed, profile_id: 123 }, { ...claimed, total_bytes: 0 }, { ...claimed, total_bytes: 1.5 },
    { state: 'chunk', ticket, offset: 0, bytes: 'YQ==' }, { state: 'staged', ticket, next_offset: 0 },
  ]) expect(() => parseHostPrivateTwinResult(value)).toThrow('invalid_host_private_twin_frame')
})
