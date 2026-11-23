import { createHash as createNodeHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createHash } from '../../src/node/builtin_modules/implemented/crypto.ts'

it.each(['sha1', 'sha256', 'sha512'])('copies %s state without consuming or sharing the prefix', (algorithm) => {
  const bytes = Uint8Array.of(0, 127, 255)
  const worker = createHash(algorithm).update('消息[').update(bytes)
  const node = createNodeHash(algorithm).update('消息[').update(bytes)
  bytes.fill(1)

  const workerBranch = worker.copy().update('first')
  const nodeBranch = node.copy().update('first')
  expect(workerBranch.copy().update(']').digest('hex')).toBe(nodeBranch.copy().update(']').digest('hex'))
  expect(worker.copy().update('second]').digest('base64')).toBe(node.copy().update('second]').digest('base64'))
  expect(workerBranch.update('!]').digest()).toEqual(nodeBranch.update('!]').digest())
  expect(worker.update('original]').digest('hex')).toBe(node.update('original]').digest('hex'))
})

it('refuses further operations after digest just as Node does', () => {
  const worker = createHash('SHA-256').update('prefix')
  const node = createNodeHash('sha256').update('prefix')
  const original = worker.copy()
  expect(worker.digest('hex')).toBe(node.digest('hex'))
  for (const operation of [() => worker.copy(), () => worker.update('more'), () => worker.digest()]) {
    expect(operation).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }))
  }
  expect(original.update('more').digest('hex')).toBe(createNodeHash('sha256').update('prefixmore').digest('hex'))
})
