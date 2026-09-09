import { describe, expect, it } from 'vitest'
import { parseInboundFrame } from '../../src/transport/frames.ts'

describe('tunnel init frame', () => {
  it('retains the selected overlay order', () => {
    expect(parseInboundFrame({
      t: 'init',
      image: 'base.tar.gz',
      overlays: ['workspace.tar.gz', 'session.tar.gz'],
    })).toEqual({
      t: 'init',
      image: 'base.tar.gz',
      overlays: ['workspace.tar.gz', 'session.tar.gz'],
    })
  })

  it('rejects a missing or non-string overlay list', () => {
    expect(() => parseInboundFrame({ t: 'init', image: 'base.tar.gz' })).toThrow(/array of string overlay urls/)
    expect(() => parseInboundFrame({ t: 'init', image: 'base.tar.gz', overlays: [1] }))
      .toThrow(/array of string overlay urls/)
  })

  it('retains an optional structured-clone local profile and rejects malformed metadata', () => {
    const encryptionKey = { type: 'secret' } as CryptoKey
    expect(parseInboundFrame({
      t: 'init', image: 'base.tar.gz', overlays: [],
      localProfile: { environmentId: 'staging', profileId: 'profile', encryptionKey },
    })).toEqual({
      t: 'init', image: 'base.tar.gz', overlays: [],
      localProfile: { environmentId: 'staging', profileId: 'profile', encryptionKey },
    })
    expect(() => parseInboundFrame({
      t: 'init', image: 'base.tar.gz', overlays: [], localProfile: { environmentId: 'staging' },
    })).toThrow(/invalid local profile/u)
  })
})
