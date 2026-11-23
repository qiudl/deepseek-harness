import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parseHostRuntimeEntryOriginsConfiguration, parseHostRuntimeEntryOriginsJson } from '../src/runtime-entry-bootstrap.ts'

const installation = join(tmpdir(), 'runtime-entry-bootstrap')
const sha256 = 'a'.repeat(64)

function configuration() {
  return {
    schemaVersion: 1,
    implementationDigest: sha256,
    compositionDigest: 'b'.repeat(64),
    artifactPins: [
      { path: join(installation, 'project-operation-native-entry.js'), sha256 },
      { path: join(installation, 'project-operation-journal.js'), sha256 },
    ],
  }
}

describe('native runtime entry bootstrap', () => {
  it('leaves native entry disabled when the embedding supplies no policy', () => {
    expect(parseHostRuntimeEntryOriginsJson(undefined)).toBeUndefined()
  })

  it('detaches and freezes the parsed embedding policy', () => {
    const original = configuration()
    const result = parseHostRuntimeEntryOriginsConfiguration(original)
    expect(parseHostRuntimeEntryOriginsJson(JSON.stringify(original))).toEqual(result)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.artifactPins)).toBe(true)
    expect(Object.isFrozen(result.artifactPins[0])).toBe(true)
    original.artifactPins[0]!.path = join(installation, 'different.js')
    expect(result.artifactPins[0]?.path).toBe(join(installation, 'project-operation-native-entry.js'))
  })

  it('requires a closed versioned policy and both distinct runtime artifacts', () => {
    const original = configuration()
    const [entry, journal] = original.artifactPins
    const other = { path: join(installation, 'unrelated.js'), sha256 }
    for (const invalid of [
      { ...original, schemaVersion: 2 },
      { ...original, authority: 'caller' },
      { ...original, artifactPins: [entry] },
      { ...original, artifactPins: [entry, entry] },
      { ...original, artifactPins: [other, journal] },
      { ...original, artifactPins: [entry, other] },
    ]) expect(() => parseHostRuntimeEntryOriginsConfiguration(invalid)).toThrow()
  })

  it('rejects artifact coordinates that the embedding cannot bind canonically', () => {
    const original = configuration()
    const [entry, journal] = original.artifactPins
    for (const path of [
      1,
      'project-operation-native-entry.js',
      installation + sep + '..' + sep + 'project-operation-native-entry.js',
      join(installation, 'escaped\nname.js'),
      join(installation, '\uD800.js'),
      join(installation, '界'.repeat(700)),
    ]) {
      expect(() => parseHostRuntimeEntryOriginsConfiguration({
        ...original, artifactPins: [{ ...entry, path }, journal],
      })).toThrow()
    }
  })

  it('bounds the complete projection as well as the serialized parent envelope', () => {
    const original = configuration()
    const additional = Array.from({ length: 40 }, (_, i) => ({
      path: join(installation, String(i), 'p'.repeat(1800)), sha256,
    }))
    expect(() => parseHostRuntimeEntryOriginsConfiguration({
      ...original, artifactPins: [...original.artifactPins, ...additional],
    })).toThrow('invalid_runtime_entry_bootstrap')
    expect(() => parseHostRuntimeEntryOriginsJson(' '.repeat(65_537))).toThrow('invalid_runtime_entry_bootstrap')
  })
})
