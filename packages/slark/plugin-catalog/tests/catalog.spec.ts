import { describe, expect, it } from 'vitest'
import {
  CatalogSnapshotStore,
  buildCatalogSnapshot,
  queryCatalog,
  type CatalogSnapshotInput,
} from '../src/index.ts'

const memory = `
url: https://github.com/00080000/dsh-project-memory
name: 00080000/dsh-project-memory
category: memory
tarball: https://github.com/00080000/dsh-project-memory/releases/download/v0.3.1/dsh-project-memory-0.3.1.tgz
description:
  zh: 项目记忆插件
  en: Project memory plugin
`

const input = (files: CatalogSnapshotInput['files']): CatalogSnapshotInput => ({
  sourceCommit: '51d6fbf5eae407706b212e3e20d1414cbb192602',
  generatedAt: '2026-08-30T09:07:24.000Z',
  files,
})

describe('plugin catalog snapshots', () => {
  it('normalizes entries and keeps identity and revision stable across file order', () => {
    const second = memory
      .replaceAll('00080000/dsh-project-memory', '0QwQ0/dsh-ui-auth')
      .replace('category: memory', 'category: security')
    const firstSnapshot = buildCatalogSnapshot(input([
      { path: 'memory.yml', content: memory },
      { path: 'security.yml', content: second },
    ]))
    const reordered = buildCatalogSnapshot(input([
      { path: 'security.yml', content: second },
      { path: 'memory.yml', content: memory },
    ]))

    expect(firstSnapshot).toEqual(reordered)
    expect(firstSnapshot.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(firstSnapshot.entries).toHaveLength(2)
    expect(firstSnapshot.entries[0]).toMatchObject({
      ownerName: '00080000/dsh-project-memory',
      category: 'memory',
      repositoryUrl: 'https://github.com/00080000/dsh-project-memory',
      installability: 'catalog_candidate',
    })
    expect(firstSnapshot.entries[0]?.entryId).toMatch(/^[a-f0-9]{32}$/)
  })

  it('accepts current curated monorepo, display-name, underscore, CDN tarball, and long-description shapes', () => {
    const source = `
url: https://github.com/example-owner/plugin_repo/tree/main/packages/agent-plugin
name: Session Lens
category: workflow
tarball: https://release-assets.githubusercontent.com/github-production-release-asset/example/plugin.tgz
description:
  en: ${'Useful catalog description. '.repeat(100)}
`
    const snapshot = buildCatalogSnapshot(input([{ path: 'monorepo.yml', content: source }]))

    expect(snapshot.entries[0]).toMatchObject({
      ownerName: 'Session Lens',
      repositoryUrl: 'https://github.com/example-owner/plugin_repo/tree/main/packages/agent-plugin',
      declaredTarballUrl: 'https://release-assets.githubusercontent.com/github-production-release-asset/example/plugin.tgz',
    })
  })

  it.each([
    ['oversized file', [{ path: 'large.yml', content: `name: a/b\nurl: https://github.com/a/b\ndescription:\n  en: ${'x'.repeat(8193)}` }]],
    ['yaml alias', [{ path: 'alias.yml', content: 'base: &base x\nname: a/b\nurl: https://github.com/a/b\ncategory: memory\ndescription: { en: *base }' }]],
    ['unicode owner', [{ path: 'unicode.yml', content: memory.replace('00080000/dsh-project-memory', 'trusted/dsh\u202Eexe') }]],
  ])('rejects %s', (_name, files) => {
    expect(() => buildCatalogSnapshot(input(files))).toThrow()
  })

  it('rejects duplicate canonical sources', () => {
    expect(() => buildCatalogSnapshot(input([
      { path: 'one.yml', content: memory },
      { path: 'two.yml', content: memory.replace('category: memory', 'category: security') },
    ]))).toThrow(/duplicate/i)
  })

  it('keeps the last successful snapshot when a refresh fails', () => {
    const store = new CatalogSnapshotStore()
    const accepted = store.refresh(input([{ path: 'memory.yml', content: memory }]))

    expect(() => store.refresh(input([{ path: 'broken.yml', content: 'name: [' }]))).toThrow()
    expect(store.current()).toBe(accepted)
  })

  it('combines filters, uses stable ordering, and resumes an opaque cursor', () => {
    const security = memory
      .replaceAll('00080000/dsh-project-memory', '0QwQ0/dsh-ui-auth')
      .replace('category: memory', 'category: security')
      .replace('Project memory plugin', 'Memory security gateway')
    const snapshot = buildCatalogSnapshot(input([
      { path: 'security.yml', content: security },
      { path: 'memory.yml', content: memory },
    ]))

    const filtered = queryCatalog(snapshot, {
      query: 'memory',
      categories: ['security'],
      installed: 'no',
      installedEntryIds: [snapshot.entries.find(item => item.ownerName.includes('project-memory'))!.entryId],
      limit: 10,
    })
    expect(filtered.items.map(item => item.ownerName)).toEqual(['0QwQ0/dsh-ui-auth'])

    const first = queryCatalog(snapshot, { limit: 1 })
    const secondPage = queryCatalog(snapshot, { limit: 1, cursor: first.nextCursor! })
    expect(first.items[0]!.entryId).not.toBe(secondPage.items[0]!.entryId)
    expect(first.total).toBe(2)
  })

  it('distinguishes verifiable prebuilt distribution from source checkout without claiming build-script safety', () => {
    const snapshot = buildCatalogSnapshot({
      ...input([{ path: 'memory.yml', content: memory }]),
      packages: [{ repositoryUrl: 'https://github.com/00080000/dsh-project-memory', packageName: 'dsh-project-memory' }],
    })
    expect(queryCatalog(snapshot, { distributions: ['prebuilt'] }).total).toBe(1)
    expect(queryCatalog(snapshot, { distributions: ['source'] }).total).toBe(0)
  })

  it.each([
    'I need a plugin for project memory',
    '帮我找项目记忆插件',
  ])('matches a natural-language capability request: %s', (query) => {
    const pdf = memory
      .replaceAll('00080000/dsh-project-memory', 'example/dsh-pdf-reader')
      .replace('category: memory', 'category: documents')
      .replace('项目记忆插件', 'PDF 阅读插件')
      .replace('Project memory plugin', 'PDF reader plugin')
    const weather = memory
      .replaceAll('00080000/dsh-project-memory', 'example/dsh-weather')
      .replace('category: memory', 'category: tools')
      .replace('项目记忆插件', '天气预报插件')
      .replace('Project memory plugin', 'Weather forecast plugin')
    const snapshot = buildCatalogSnapshot(input([
      { path: 'memory.yml', content: memory }, { path: 'pdf.yml', content: pdf }, { path: 'weather.yml', content: weather },
    ]))
    expect(queryCatalog(snapshot, { query }).items.map(item => item.ownerName))
      .toEqual(['00080000/dsh-project-memory'])
  })

  it('does not let the generic Chinese word for plugin pollute capability matches', () => {
    const weather = memory
      .replaceAll('00080000/dsh-project-memory', 'example/dsh-weather')
      .replace('项目记忆插件', '天气预报插件')
      .replace('Project memory plugin', 'Weather forecast plugin')
    const pdf = memory
      .replaceAll('00080000/dsh-project-memory', 'example/dsh-pdf-reader')
      .replace('项目记忆插件', 'PDF 阅读插件')
      .replace('Project memory plugin', 'PDF reader plugin')
    const snapshot = buildCatalogSnapshot(input([
      { path: 'memory.yml', content: memory }, { path: 'weather.yml', content: weather }, { path: 'pdf.yml', content: pdf },
    ]))

    expect(queryCatalog(snapshot, { query: '帮我找天气插件' }).items.map(item => item.ownerName))
      .toEqual(['example/dsh-weather'])
  })

  it('removes English intent filler and normalizes common inflections', () => {
    const review = memory
      .replaceAll('00080000/dsh-project-memory', 'example/dsh-diff-review')
      .replace('Project memory plugin', 'Review git diffs inside DSH')
    const snapshot = buildCatalogSnapshot(input([
      { path: 'memory.yml', content: memory }, { path: 'review.yml', content: review },
    ]))

    expect(queryCatalog(snapshot, { query: 'Find me something for reviewing git diffs inside DSH.' })
      .items.map(item => item.ownerName)).toEqual(['example/dsh-diff-review'])
  })

  it('reports stale snapshots and rejects cursors from another revision', () => {
    const snapshot = buildCatalogSnapshot(input([{ path: 'memory.yml', content: memory }]))
    const page = queryCatalog(snapshot, { limit: 1 }, Date.parse('2026-08-31T09:20:00.000Z'))
    expect(page.stale).toBe(true)
    expect(() => queryCatalog({ ...snapshot, revision: 'f'.repeat(64) }, {
      limit: 1,
      cursor: page.nextCursor ?? Buffer.from(JSON.stringify({ revision: snapshot.revision, offset: 0 })).toString('base64url'),
    })).toThrow(/cursor/i)
  })

  it.each([
    [{ unexpected: true }, /undeclared field/i],
    [{ categories: ['workflow', 1] }, /categories/i],
    [{ sourceKinds: ['pypi'] }, /source kinds/i],
    [{ distributions: ['no-build-scripts'] }, /distributions/i],
    [{ installedEntryIds: ['not-an-entry-id'] }, /installed entry ids/i],
    [{ installed: 'sometimes' }, /installed filter/i],
    [{ sort: 'stars' }, /sort/i],
    [{ cursor: 'x'.repeat(513) }, /cursor/i],
  ])('rejects malformed service-level query input %#', (query, message) => {
    const snapshot = buildCatalogSnapshot(input([{ path: 'memory.yml', content: memory }]))
    expect(() => queryCatalog(snapshot, query as never)).toThrow(message)
  })
})
