/** Cold request latency runs outside concurrent corpus preparation. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBenchPhase } from './run-bench-suite.ts'

const command = vi.hoisted(() => vi.fn<(root: string, args: readonly string[]) => void>())
vi.mock('./compile-referenced-projects.ts', () => ({ runPnpmCommand: command }))

const projection = 'benchmarks/session-corpus/projection-list.bench.ts'
const corpus = 'benchmarks/session-corpus/session-corpus.bench.ts'
const originalPhase = process.env['DSH_BENCH_REPORT_PHASE']

afterEach(() => {
  command.mockReset()
  if (originalPhase === undefined) delete process.env['DSH_BENCH_REPORT_PHASE']
  else process.env['DSH_BENCH_REPORT_PHASE'] = originalPhase
})

describe('benchmark phase allocation', () => {
  it('excludes cold projection-list latency while retaining parallel corpus work', () => {
    runBenchPhase('/fixture', 'first')
    expect(command).toHaveBeenCalledExactlyOnceWith('/fixture',
      expect.arrayContaining([`--exclude=${projection}`]))
    expect(command.mock.calls[0]?.[1]).not.toContain(`--exclude=${corpus}`)
  })

  it('runs cold projection-list latency in the existing exclusive phase', () => {
    runBenchPhase('/fixture', 'last')
    expect(command).toHaveBeenCalledExactlyOnceWith('/fixture',
      expect.arrayContaining([projection, '--no-file-parallelism', '--maxWorkers=1']))
  })
})
