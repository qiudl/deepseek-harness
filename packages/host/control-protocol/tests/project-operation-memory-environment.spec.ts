import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  HOST_PROJECT_MEMORY_AUDIENCE,
  parseHostProjectMemoryEnvironment,
  parseHostProjectMemoryEnvironments,
} from '../src/index.ts'

function policy() {
  const key = generateKeyPairSync('ed25519')
  return {
    audience: 'urn:slark:project-memory:v1',
    environmentKey: 'staging',
    keyring: {
      version: 1,
      environmentId: randomUUID(),
      issuer: 'https://cloud.test',
      keys: [
        {
          kid: 'dsh-assertion-memory-test',
          publicKeyPem: key.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          validFrom: 1,
          validUntil: 20000,
        },
      ],
    },
  }
}
it('pins the independently declared purpose and accepts only explicit bounded public environment policies', () => {
  expect(HOST_PROJECT_MEMORY_AUDIENCE).toBe('urn:slark:project-memory:v1')
  expect(parseHostProjectMemoryEnvironments(undefined)).toEqual([])
  expect(parseHostProjectMemoryEnvironments('[]')).toEqual([])
  const original = policy(),
    parsed = parseHostProjectMemoryEnvironment(original)
  expect(parsed).toEqual(original)
  expect(parsed).not.toBe(original)
  expect(parseHostProjectMemoryEnvironments(JSON.stringify([original]))).toEqual([original])
  expect(parseHostProjectMemoryEnvironments(JSON.stringify(Array.from({ length: 4 }, policy)))).toHaveLength(4)
  for (const raw of [
    '{',
    '{}',
    ' '.repeat(32769),
    JSON.stringify(Array.from({ length: 5 }, policy)),
    JSON.stringify([original, original]),
  ])
    expect(() => parseHostProjectMemoryEnvironments(raw)).toThrow()
})
it('refuses private, unrelated, unknown and non-Ed25519 keys before worker projection', () => {
  const p = policy(),
    ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  for (const candidate of [
    { ...p, audience: 'urn:slark:other:v1' },
    { ...p, environmentKey: 'https://cloud.test' },
    { ...p, privateKeyPem: 'forbidden' },
    { ...p, keyring: { ...p.keyring, privateKeyPem: 'forbidden' } },
    { ...p, keyring: { ...p.keyring, keys: [{ ...p.keyring.keys[0], privateKeyPem: 'forbidden' }] } },
    {
      ...p,
      keyring: {
        ...p.keyring,
        keys: [{ ...p.keyring.keys[0], publicKeyPem: ec.publicKey.export({ format: 'pem', type: 'spki' }).toString() }],
      },
    },
    { ...p, keyring: { ...p.keyring, keys: [{ ...p.keyring.keys[0], publicKeyPem: 'invalid' }] } },
  ])
    expect(() => parseHostProjectMemoryEnvironment(candidate)).toThrow()
})
