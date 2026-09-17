import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { MigrationOwnerStateBundle } from '../src/migration-export.ts'

const fsFaults = vi.hoisted(() => ({
  changeLog: false,
  escapeProject: false,
}))
const zstdFaults = vi.hoisted(() => ({ tooLarge: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (path: string, flags: number) => {
      const handle = await actual.open(path, flags)
      if (fsFaults.changeLog && path.endsWith('.jsonl')) {
        const stat = handle.stat.bind(handle)
        let calls = 0
        vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
          const metadata = await stat(options as { bigint: true })
          calls += 1
          return calls === 1 ? metadata : { ...metadata, mtimeNs: metadata.mtimeNs + 1n }
        })
      }
      return handle
    },
    realpath: async (path: string) => fsFaults.escapeProject && path.endsWith('_no-cwd')
      ? join(tmpdir(), 'dsh-migration-export-escaped')
      : actual.realpath(path),
  }
})

vi.mock('../src/zstd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/zstd.js')>()
  return {
    ...actual,
    createZstdFrameDecoder: () => zstdFaults.tooLarge
      ? {
        *decode() { yield { byteLength: 256 * 1024 * 1024 + 1 } },
        close() {},
      }
      : actual.createZstdFrameDecoder(),
  }
})

const { FileJsonlMigrationExportSource } = await import('../src/migration-export-source.ts')
const { compressZstdFrame } = await import('../src/zstd.ts')

const uid = process.getuid?.() ?? 0
const roots: string[] = []
const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}

async function sourceFixture(compressed = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migration-export-fault-'))
  roots.push(root)
  const project = join(root, '_no-cwd')
  const session = join(project, 'fault')
  await mkdir(session, { recursive: true, mode: 0o700 })
  const header = {
    type: 'session', version: compressed ? 0 : SESSION_FORMAT_VERSION,
    id: 'fault', createdAt: 1, delegationDepth: 0,
    ...(compressed ? {} : { isSeeded: false }),
  }
  const plain = `${JSON.stringify(header)}\n`
  const log = join(session, compressed ? 'session.jsonl.zstd' : `session.v${SESSION_FORMAT_VERSION}.jsonl`)
  await writeFile(log, compressed ? await compressZstdFrame(plain) : plain, { mode: 0o600 })
  return {
    root,
    project,
    log,
    source: new FileJsonlMigrationExportSource(root, uid, { read: async () => ownerState }),
  }
}

afterEach(async () => {
  fsFaults.changeLog = false
  fsFaults.escapeProject = false
  zstdFaults.tooLarge = false
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('migration export source filesystem faults', () => {
  it('rejects a log whose metadata changes during its bounded read', async () => {
    const fixture = await sourceFixture()
    fsFaults.changeLog = true
    await expect(fixture.source.listSnapshots()).rejects.toThrow(/source_changed/u)
  })

  it('rejects a canonical project directory outside the owner root', async () => {
    const fixture = await sourceFixture()
    fsFaults.escapeProject = true
    await expect(fixture.source.listSnapshots()).rejects.toThrow(/source_unsafe/u)
  })

  it('rejects a compressed log whose decoded payload exceeds the source bound', async () => {
    const fixture = await sourceFixture(true)
    zstdFaults.tooLarge = true
    await expect(fixture.source.listSnapshots()).rejects.toThrow(/source_too_large/u)
  })
})
