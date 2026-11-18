import { describe, expect, it } from 'vitest'
import { parseHostRuntimeEntryOriginsConfiguration, parseHostRuntimeEntryOriginsJson } from '../src/runtime-entry-bootstrap.ts'

const digest = 'a'.repeat(64)
const config = {
  schemaVersion: 1,
  implementationDigest: digest,
  compositionDigest: digest,
  artifactPins: [
    { path: '/opt/dsh/project-operation-native-entry.js', sha256: digest },
    { path: '/opt/dsh/project-operation-journal.js', sha256: digest },
  ],
}

describe('native runtime entry startup projection', () => {
  it('accepts only detached, immutable installation pins', () => {
    const parsed = parseHostRuntimeEntryOriginsConfiguration(config)
    expect(parsed).toEqual(config)
    expect(parsed).not.toBe(config)
    expect(parsed.artifactPins).not.toBe(config.artifactPins)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.artifactPins)).toBe(true)
    expect(Object.isFrozen(parsed.artifactPins[0])).toBe(true)
    expect(parseHostRuntimeEntryOriginsJson(undefined)).toBeUndefined()
    expect(parseHostRuntimeEntryOriginsJson(JSON.stringify(config))).toEqual(config)
  })

  it('rejects malformed installation paths, digests and missing required artifacts', () => {
    for (const value of [null, {}, { ...config, schemaVersion: 2 },
      { ...config, implementationDigest: 'bad' }, { ...config, compositionDigest: 'bad' },
      { ...config, artifactPins: [] }, { ...config, artifactPins: [config.artifactPins[0]] },
      { ...config, artifactPins: [config.artifactPins[0], config.artifactPins[0]] },
      { ...config, artifactPins: [{ ...config.artifactPins[0], path: '/opt/dsh/other.js' }, config.artifactPins[1]] },
      { ...config, artifactPins: [config.artifactPins[0], { ...config.artifactPins[1], path: '/opt/dsh/other.js' }] },
      { ...config, artifactPins: [config.artifactPins[0], { path: '/opt/dsh/../project-operation-journal.js', sha256: digest }] },
      { ...config, artifactPins: [config.artifactPins[0], { path: 'relative/project-operation-journal.js', sha256: digest }] },
      { ...config, artifactPins: [config.artifactPins[0], { path: '/opt/dsh/\nproject-operation-journal.js', sha256: digest }] },
      { ...config, artifactPins: [config.artifactPins[0], { path: '/opt/dsh/\ud800project-operation-journal.js', sha256: digest }] },
      { ...config, artifactPins: [config.artifactPins[0], { path: '/opt/' + 'x'.repeat(2049) + '/project-operation-journal.js', sha256: digest }] },
      { ...config, artifactPins: [config.artifactPins[0], { ...config.artifactPins[1], sha256: 'bad' }] },
      { ...config, artifactPins: [config.artifactPins[0], { ...config.artifactPins[1], token: 'secret' }] },
      { ...config, extra: true },
    ]) expect(() => parseHostRuntimeEntryOriginsConfiguration(value)).toThrow()
  })

  it('bounds both the parsed projection and raw parent JSON', () => {
    const extraPins = Array.from({ length: 62 }, (_, index) => ({
      path: `/opt/dsh/${String(index).padStart(2, '0')}-${'x'.repeat(1100)}.js`, sha256: digest,
    }))
    expect(() => parseHostRuntimeEntryOriginsConfiguration({ ...config,
      artifactPins: [...config.artifactPins, ...extraPins] })).toThrow('invalid_runtime_entry_bootstrap')
    expect(() => parseHostRuntimeEntryOriginsConfiguration({ ...config,
      artifactPins: [...config.artifactPins, ...extraPins, extraPins[0]] })).toThrow()
    expect(() => parseHostRuntimeEntryOriginsJson('x'.repeat(65_537)))
      .toThrow('invalid_runtime_entry_bootstrap')
    expect(() => parseHostRuntimeEntryOriginsJson('{')).toThrow(SyntaxError)
  })
})
