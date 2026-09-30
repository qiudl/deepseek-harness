/** Experimental-package publication and dependency constraints. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspaceManifest,
  type PackageManifest,
  expectedDshPackageFiles,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('package payload constraints', () => {
  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'lib/invariant.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })
})


describe('Host client publication', () => {
  it('ships the declared independent Host control client', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-desktop-host',
      exports: { './client': { default: './lib/host-control-client.js' } },
    })).toContain('lib/host-control-client.js')
  })

  it('does not accept an unknown client artifact', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-desktop-host',
      exports: { './client': { default: './lib/unowned-client.js' } },
    })).not.toContain('lib/unowned-client.js')
  })
})


describe('Host client exact payload validation', () => {
  const dir = 'packages/host/desktop-host'
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as PackageManifest

  it('accepts the current declared payload', () => {
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  })

  it('rejects omission of the standalone client', () => {
    const files = manifest.files!.filter(file => file !== 'lib/host-control-client.js')
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files } }))
      .toContainEqual(expect.stringContaining('package.json files must be'))
  })

  it('rejects extra unowned runtime files', () => {
    const files = [...manifest.files!, 'lib/unowned-client.js']
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files } }))
      .toContainEqual(expect.stringContaining('package.json files must be'))
  })
})
