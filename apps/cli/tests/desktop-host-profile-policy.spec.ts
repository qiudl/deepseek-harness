import { describe, expect, it } from 'vitest'
import { assertProfileInvocationPolicy } from '../src/profile-boot.ts'

describe('desktop Host installation-owned profile policy', () => {
  it('rejects user overlays and forwarded arguments while retaining ordinary profile customization', () => {
    expect(() => { assertProfileInvocationPolicy('desktop-host', ['/tmp/override.yml'], []) })
      .toThrow(/does not accept user overlays or arguments/u)
    expect(() => { assertProfileInvocationPolicy('desktop-host', [], ['--untrusted']) })
      .toThrow(/does not accept user overlays or arguments/u)
    expect(() => { assertProfileInvocationPolicy('desktop-host', [], []) }).not.toThrow()
    expect(() => { assertProfileInvocationPolicy('web', ['/tmp/override.yml'], ['--allowed']) }).not.toThrow()
  })
})
