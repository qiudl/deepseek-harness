/** Paired reads use real local providers, live Agents and Session policy; no model or external device runs. */
import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { HostTaskTargetStepBody } from '@deepseek-ai/dsh-host-control-protocol'
import { PairedTaskTargetFiles } from '../src/desktop-task-target-files.ts'

const permissions: HostTaskTargetStepBody['permissions'] = Object.freeze({ forceReadOnly: false, routeReadOnly: false,
  filesystem: 'read-only', networkAccess: false, skills: null, toolAllowlist: null })
async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, sandbox = false): Promise<void> {
  const f = await setup(sandbox)
  try { await work(f) } finally { await f.ctx.fiber.dispose(); await rm(f.dir, { recursive: true, force: true }) }
}
async function setup(sandbox: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'paired-files-')), ctx = new Context()
  try {
    await writeFile(join(dir, 'original.txt'), 'original 文件\n')
    await mkdir(join(dir, 'child'))
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: dir })
    const fsFiber = sandbox ? await ctx.plugin(SandboxedFileSystem, { cwd: dir }) : await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(WorkingDirectoryService, { defaultDirectory: dir })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId(randomUUID()), {}, { cwd: dir })
    const lifetime = new AbortController()
    const invoke = async (name: string, args: Record<string, string>, who = agent) => {
      const batch = await ctx.tools.execute({ agent: who, signal: lifetime.signal,
        calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }] })
      expect(batch.results).toHaveLength(1)
      return batch.results[0]!.result
    }
    return { dir, ctx, agent, harness, lifetime, invoke, fsFiber }
  } catch (error) { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }); throw error }
}
it.each([false, true])('reads and lists through actual native execution without writes or widening policy: sandboxed=%s', async sandbox => fixture(async (f) => {
  const before = await readFile(join(f.dir, 'original.txt')), owner = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)
  expect(owner.definitions.map(d => d.name)).toEqual(['read', 'list_directory'])
  for (const d of owner.definitions) expect(f.ctx.tools.get(d.name, f.agent)).toBe(d)
  const read = await f.invoke('read', { file_path: 'original.txt' })
  expect(read.isError).toBe(false)
  expect(JSON.stringify(read)).toContain('original 文件')
  const list = await f.invoke('list_directory', { path: '.' })
  expect(list.isError).toBe(false)
  expect(JSON.stringify(list)).toContain('original.txt')
  expect(await readFile(join(f.dir, 'original.txt'))).toEqual(before)
  expect(f.ctx.sandboxPolicy.resolve({ session: f.agent.session }).mode).toBe('read-only')
  await owner.close()
  expect(f.ctx.tools.get('read', f.agent)).toBeUndefined()
  expect(f.ctx.tools.get('list_directory', f.agent)).toBeUndefined()
}, sandbox))
it('keeps null, empty and finite Source ceilings distinct and rejects foreign Agent or copied permissions', async () => fixture(async (f) => {
  const empty = new PairedTaskTargetFiles(f.ctx, f.agent, { ...permissions, toolAllowlist: [] }, () => {}, f.lifetime.signal)
  expect(empty.definitions).toEqual([]); await empty.close()
  const finite: HostTaskTargetStepBody['permissions'] = { ...permissions, filesystem: 'workspace-write',
    networkAccess: true, toolAllowlist: ['read'] }
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, finite, () => {}, f.lifetime.signal)
  expect(owner.definitions.map(d => d.name)).toEqual(['read'])
  expect((await f.invoke('read', { file_path: 'original.txt' })).isError).toBe(false)
  const other = await f.harness.create(SessionId(randomUUID()), {}, { cwd: f.dir })
  expect(() => { owner.assertCurrent(other, finite) }).toThrow('paired_target_files')
  expect(() => { owner.assertCurrent(f.agent, { ...finite }) }).toThrow('paired_target_files')
  expect((await f.invoke('read', { file_path: 'original.txt' }, other)).isError).toBe(true)
  await owner.close()
  expect(() => new PairedTaskTargetFiles(f.ctx, f.agent, { ...permissions, skills: ['legacy'] }, () => {}, f.lifetime.signal)).toThrow('unsupported')
}))
it('invalidates on actual Session directory or standing policy change before another read', async () => fixture(async (f) => {
  const first = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)
  await f.ctx.workingDirectory.set(f.agent, join(f.dir, 'child'))
  expect(() => { first.assertCurrent() }).toThrow('paired_target_files')
  await first.close()
  const next = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)
  setSandboxMode(f.agent.session, 'workspace-write')
  expect(() => { next.assertCurrent() }).toThrow('paired_target_files')
  await next.close()
}))
it('keeps historical provider facts after normal close without permitting another execution', async () => fixture(async (f) => {
  let allowed = true
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => { if (!allowed) throw Error('current owner denied') }, f.lifetime.signal)
  const current = owner.captureCurrent()
  expect((await f.invoke('read', { file_path: 'original.txt' })).isError).toBe(false)
  allowed = false
  Reflect.set(owner, 'current', () => {})
  expect(() => { owner.assertCurrent() }).toThrow('current owner denied')
  expect((await f.invoke('read', { file_path: 'original.txt' })).isError).toBe(true)
  allowed = true
  await owner.close(); allowed = false
  expect(current()).toBe(true)
  expect(() => { owner.assertCurrent() }).toThrow('closed')
  expect((await f.invoke('read', { file_path: 'original.txt' })).isError).toBe(true)
  setSandboxMode(f.agent.session, 'workspace-write')
  expect(current()).toBe(false)
  const forged = Object.create(PairedTaskTargetFiles.prototype) as PairedTaskTargetFiles
  expect(() => forged.captureCurrent()).toThrow()
  expect(() => { forged.assertCurrent() }).toThrow()
}))
it('seals at the final owner recheck and awaits the original IO operation before close completes', async () => fixture(async (f) => {
  let rechecks = 0, closing: Promise<void> | undefined, closeFinished = false, armed = false
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {
    if (armed && ++rechecks === 4) {
      closing = owner.close().then(() => { closeFinished = true })
      expect(closeFinished).toBe(false)
    }
  }, f.lifetime.signal)
  armed = true
  const result = await f.invoke('read', { file_path: 'original.txt' })
  expect(result.isError).toBe(true)
  expect(closing).toBeDefined(); await closing
  expect(closeFinished).toBe(true)
  expect(f.ctx.tools.get('read', f.agent)).toBeUndefined()
  expect(await readFile(join(f.dir, 'original.txt'), 'utf8')).toBe('original 文件\n')
}))
it('rejects drift of the Source object even if the public check was replaced', async () => fixture(async (f) => {
  const mutable = { ...permissions, toolAllowlist: ['read'] }
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, mutable, () => {}, f.lifetime.signal)
  const current = owner.captureCurrent()
  mutable.toolAllowlist.push('shell')
  owner.assertCurrent = () => {}
  expect(current()).toBe(false)
  expect((await f.invoke('read', { file_path: 'original.txt' })).isError).toBe(true)
  expect(() => { Object.defineProperty(owner, 'definitions', { value: [] }) }).toThrow()
  await owner.close()
}))
it('refuses an unknown local subclass and invalidates after the original provider is removed', async () => fixture(async (f) => {
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)
  const current = owner.captureCurrent()
  await f.fsFiber.dispose()
  expect(current()).toBe(false)
  expect(() => { owner.assertCurrent() }).toThrow('paired_target_files')
  await owner.close()
  class OtherLocalFileSystem extends LocalFileSystem {}
  await f.ctx.plugin(OtherLocalFileSystem, { cwd: f.dir })
  expect(() => new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)).toThrow('unsupported')
}))
it('rejects read method replacement before IO and caller lifetime cancellation', async () => fixture(async (f) => {
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)
  const current = owner.captureCurrent(), fs = f.ctx.fs
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'readBytes')
  let entered = 0
  fs.readBytes = async () => { entered++; return Buffer.from('must not return') }
  expect(current()).toBe(false)
  expect((await f.invoke('read', { file_path: 'original.txt' })).isError).toBe(true)
  expect(entered).toBe(0)
  if (descriptor) Object.defineProperty(fs, 'readBytes', descriptor)
  else Reflect.deleteProperty(fs, 'readBytes')
  expect(current()).toBe(true)
  f.lifetime.abort(Error('owned worker stopped'))
  expect(() => { owner.assertCurrent() }).toThrow('owned worker stopped')
  await owner.close()
}))
it('bounds UTF8 reads and complete emitted JSON without returning truncated or binary content', async () => fixture(async (f) => {
  const exact = '中'.repeat(5461) + 'x'
  expect(Buffer.byteLength(exact)).toBe(16384)
  await writeFile(join(f.dir, 'exact.txt'), exact)
  await writeFile(join(f.dir, 'too-large.txt'), 'x'.repeat(16385))
  await writeFile(join(f.dir, 'binary.txt'), Buffer.from([0xff, 0, 0xff]))
  await writeFile(join(f.dir, 'escaped.txt'), '\n'.repeat(16384))
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)
  expect((await f.invoke('read', { file_path: 'exact.txt' })).isError).toBe(false)
  for (const path of ['too-large.txt', 'binary.txt', 'escaped.txt', '.', 'missing.txt', '']) {
    const result = await f.invoke('read', { file_path: path })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain(exact)
  }
  await owner.close()
}))
it('rejects excessive directory entries and complete result bytes rather than claiming a partial listing', async () => fixture(async (f) => {
  await mkdir(join(f.dir, 'many')); await mkdir(join(f.dir, 'dense'))
  await Promise.all(Array.from({ length: 129 }, (_, i) => writeFile(join(f.dir, 'many', String(i)), '')))
  await Promise.all(Array.from({ length: 128 }, (_, i) => writeFile(join(f.dir, 'dense', 'a'.repeat(240) + String(i)), '')))
  const owner = new PairedTaskTargetFiles(f.ctx, f.agent, permissions, () => {}, f.lifetime.signal)
  expect((await f.invoke('list_directory', { path: 'many' })).isError).toBe(true)
  expect((await f.invoke('list_directory', { path: 'dense' })).isError).toBe(true)
  await owner.close()
}))
