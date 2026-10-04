import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  collectPackageAliases,
  collectPackageNames,
  mappedSpecifiers,
  renderAliases,
  uncoveredPackages,
  writeRegion,
} from './gen-tsconfig-paths.ts'

const root = resolve(import.meta.dirname, '..')

describe('Host migration source resolution (REQ-20260930-0004)', () => {
  const config = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), path => ts.sys.readFile(path))
  if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    // Source-plane resolution must survive the installed package omitting its source files.
    fileExists: path => !path.replaceAll('\\', '/').includes('/node_modules/') && ts.sys.fileExists(path),
  }
  for (const entry of ['migration-export', 'migration-export-source', 'migration-import']) {
    it(`resolves ${entry} from workspace source without an artifact fallback`, () => {
      const specifier = `@deepseek-ai/dsh-session-persistence-jsonl/src/${entry}.ts`
      const result = ts.resolveModuleName(specifier, resolve(root, 'packages/host/desktop-host/src/startup.ts'), options, host).resolvedModule
      expect(result?.resolvedFileName).toBe(resolve(root, `packages/session/session-persistence-jsonl/src/${entry}.ts`))
    })
  }
})

describe('generated tsconfig package aliases', () => {
  it('maps each package to its own source directory', () => {
    const aliases = collectPackageAliases()
    expect(aliases.length).toBeGreaterThan(100)
    const session = aliases.find(alias => alias.specifier === '@deepseek-ai/dsh-session')
    expect(session).toEqual({
      specifier: '@deepseek-ai/dsh-session',
      source: './packages/core/session/src',
      hasInvariant: true,
    })
    // Sorted, so a package added anywhere lands in a stable spot in the diff.
    expect([...aliases].sort((a, b) => a.specifier.localeCompare(b.specifier))).toEqual(aliases)
    // Only packages named after their directory: the rest carry hand-written
    // aliases, because the removed wildcards could never have resolved them.
    expect(aliases.some(alias => alias.specifier === '@deepseek-ai/dsh-typert-protocol')).toBe(false)
  })

  it('yields to a hand-written alias and closes without a trailing comma', () => {
    const aliases = [
      { specifier: '@deepseek-ai/dsh-a', source: './packages/g/a/src', hasInvariant: true },
      { specifier: '@deepseek-ai/dsh-b', source: './packages/g/b/src', hasInvariant: false },
    ]
    const body = renderAliases(aliases, new Set(['@deepseek-ai/dsh-a']))

    // The hand-written bare alias is skipped; its /invariant sibling is not.
    expect(body).toBe([
      '      "@deepseek-ai/dsh-a/invariant": ["./packages/g/a/src/invariant.ts"]',
      '      "@deepseek-ai/dsh-b": ["./packages/g/b/src"]',
    ].join(',\n'))
    expect(body.endsWith(',')).toBe(false)
  })

  it('replaces only the marked region', () => {
    const text = [
      '{ "before": 1,',
      '      // BEGIN generated package aliases — pnpm run gen-tsconfig-paths',
      '      "stale": ["gone"]',
      '      // END generated package aliases',
      '  "after": 2 }',
    ].join('\n')

    const next = writeRegion(text, '      "fresh": ["kept"]')

    expect(next).toContain('{ "before": 1,')
    expect(next).toContain('  "after": 2 }')
    expect(next).toContain('"fresh": ["kept"]')
    expect(next).not.toContain('stale')
  })

  it('refuses a config without the region markers', () => {
    expect(() => writeRegion('{}', '')).toThrow('missing the generated-region markers')
  })

  it('names a package that no alias covers', () => {
    // Deleting the group wildcards removed the fallback that used to resolve a
    // package nobody had aliased. A package whose name does not match its
    // directory is skipped by the generator, so without this check it would
    // resolve through the workspace symlink to built lib/types instead.
    expect(uncoveredPackages(
      ['@deepseek-ai/dsh-a', '@deepseek-ai/dsh-b'],
      new Set(['@deepseek-ai/dsh-a', '@deepseek-ai/dsh-a/invariant']),
    )).toEqual(['@deepseek-ai/dsh-b'])

    expect(uncoveredPackages(['@deepseek-ai/dsh-a'], new Set(['@deepseek-ai/dsh-a']))).toEqual([])
  })

  it('covers every workspace package in the committed config', () => {
    const config = readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')
    // Includes the packages the generator skips because their name does not
    // match their directory: those carry hand-written aliases.
    const names = collectPackageNames()
    expect(names).toContain('@deepseek-ai/dsh-typert-protocol')
    expect(uncoveredPackages(names, mappedSpecifiers(config))).toEqual([])
  })

  it('leaves no wildcard that probes every package group', () => {
    const config = readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')
    // These two listed one candidate per group, so resolving a package late in
    // the list cost a filesystem probe — and under tsx a decorated module
    // error — for every group before it.
    expect(config).not.toContain('"@deepseek-ai/dsh-*":')
    expect(config).not.toContain('"@deepseek-ai/dsh-*/invariant":')
  })
})
