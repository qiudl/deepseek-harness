import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { shippedPresetRoot } from '../src/profile-boot.ts'

describe('shipped preset root selection', () => {
  it('keeps the cloud-only preset out of standalone DSH', async () => {
    expect((await readdir(shippedPresetRoot(false))).sort()).toEqual([
      'code',
      'cordis',
      'minimal',
      'standard',
    ])
  })

  it('exposes only the remote-only preset to a Slark cloud profile', async () => {
    expect(await readdir(shippedPresetRoot(true))).toEqual(['slark-cloud'])
  })
})
