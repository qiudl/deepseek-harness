/** Process-owned peak memory, including allocations released before the report. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { peakResidentSetBytes } from '../benchmarks/support/peak-memory.ts'
import { COVERAGE_TEST_TIMEOUT_ENV, coverageTestTimeoutOptions } from './coverage-partitions.ts'

const execute = promisify(execFile)
const MIB = 1024 * 1024
const helperUrl = new URL('../benchmarks/support/peak-memory.ts', import.meta.url).href
const nodeArgs = ['--experimental-strip-types', '--input-type=module', '--expose-gc', '-e']
// The outer case outlasts both child deadlines without lowering a shared-host lane's budget.
const processTestTimeout = Math.max(60_000,
  coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV]).testTimeout ?? 0)

async function report<Report>(code: string): Promise<Report> {
  const result = await execute(process.execPath, [...nodeArgs, code], { timeout: 30_000 })
  return JSON.parse(result.stdout) as Report
}

describe('benchmark peak resident memory', () => {
  it('includes the current resident set', () => {
    const current = process.memoryUsage().rss
    expect(peakResidentSetBytes()).toBeGreaterThanOrEqual(current)
  })

  it.skipIf(process.platform !== 'linux')('excludes the pre-exec parent resident set on Linux', async () => {
    const child = `import { peakResidentSetBytes } from ${JSON.stringify(helperUrl)};
      console.log(JSON.stringify({ peak: peakResidentSetBytes(), rss: process.memoryUsage().rss }));`
    const childArgs = JSON.stringify([...nodeArgs, child])
    const result = await report<{ parent: number; peak: number; rss: number; witness: number }>(`import { execFileSync } from 'node:child_process';
      const held = Buffer.alloc(192 * 1024 * 1024, 1);
      const parent = process.memoryUsage().rss;
      const child = JSON.parse(execFileSync(process.execPath,
        ${childArgs}, { encoding: 'utf8', timeout: 20_000 }));
      console.log(JSON.stringify({ parent, ...child, witness: held[0] }));`)
    expect(result.witness).toBe(1)
    expect(result.parent - result.peak).toBeGreaterThan(96 * MIB)
    expect(result.peak).toBeGreaterThanOrEqual(result.rss)
  }, processTestTimeout)

  it('retains the worker peak after its own allocation is released', async () => {
    const result = await report<{ allocated: number; peak: number; releasedBytes: number; witness: number }>(`import { peakResidentSetBytes } from ${JSON.stringify(helperUrl)};
      const allocated = (() => {
        const held = Buffer.alloc(128 * 1024 * 1024, 1);
        const usage = process.memoryUsage();
        return { rss: usage.rss, arrayBuffers: usage.arrayBuffers, witness: held[0] };
      })();
      globalThis.gc();
      await new Promise(resolve => setImmediate(resolve));
      globalThis.gc();
      const releasedBytes = allocated.arrayBuffers - process.memoryUsage().arrayBuffers;
      console.log(JSON.stringify({ allocated: allocated.rss, peak: peakResidentSetBytes(), releasedBytes, witness: allocated.witness }));`)
    expect(result.witness).toBe(1)
    expect(result.releasedBytes).toBeGreaterThan(96 * MIB)
    expect(result.peak).toBeGreaterThanOrEqual(result.allocated)
  }, processTestTimeout)
})
