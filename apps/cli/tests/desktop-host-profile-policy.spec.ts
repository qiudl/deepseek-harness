import { describe, expect, it } from 'vitest'
import { assertProfileInvocationPolicy, parseDefaultProfilePlugins } from '../src/profile-boot.ts'

describe('desktop Host installation-owned profile policy', () => {
  it('rejects user overlays and forwarded arguments while retaining ordinary profile customization', () => {
    expect(() => { assertProfileInvocationPolicy('desktop-host', ['/tmp/override.yml'], []) })
      .toThrow(/does not accept user overlays or arguments/u)
    expect(() => { assertProfileInvocationPolicy('desktop-host', [], ['--untrusted']) })
      .toThrow(/does not accept user overlays or arguments/u)
    expect(() => { assertProfileInvocationPolicy('desktop-host', [], []) }).not.toThrow()
    expect(() => { assertProfileInvocationPolicy('slark-desktop-host', ['/tmp/override.yml'], []) })
      .toThrow(/does not accept user overlays or arguments/u)
    expect(() => { assertProfileInvocationPolicy('slark-desktop-host', [], ['--untrusted']) })
      .toThrow(/does not accept user overlays or arguments/u)
    expect(() => { assertProfileInvocationPolicy('slark-desktop-host', [], []) }).not.toThrow()
    expect(() => { assertProfileInvocationPolicy('web', ['/tmp/override.yml'], ['--allowed']) }).not.toThrow()
  })
})

describe('Host default Profile plugins', () => {
  it('accepts only a bounded exact name and version list', () => {
    expect(parseDefaultProfilePlugins(undefined)).toEqual([])
    expect(parseDefaultProfilePlugins('[{"name":"dsh-worktable","version":"0.4.0"}]'))
      .toEqual([{ name: 'dsh-worktable', version: '0.4.0' }])
    for (const value of [
      '{}',
      '[{"name":"dsh-worktable","version":"latest"}]',
      '[{"name":"@deepseek-ai/dsh-base","version":"1.0.0"}]',
      '[{"name":"dsh-worktable","version":"0.4.0","url":"https://example.invalid"}]',
      '[{"name":"dsh-worktable","version":"0.4.0"},{"name":"dsh-worktable","version":"0.4.0"}]',
    ]) expect(() => parseDefaultProfilePlugins(value)).toThrow('invalid default Profile plugins')
  })
})
