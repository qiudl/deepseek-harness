import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SlarkDeviceTaskRequest, SlarkDeviceTaskResult } from '@deepseek-ai/dsh-slark-device-client'
import { describe, expect, it, vi } from 'vitest'
import SlarkRemoteFileSystem from '../src/index.ts'

function success(operation: string, result: unknown, version: 1 | 2 = 1): SlarkDeviceTaskResult {
  return {
    taskId: '11111111-1111-4111-8111-111111111111',
    state: 'completed',
    stateVersion: 3,
    authorityVersion: 7,
    terminalCode: null,
    result: new TextEncoder().encode(JSON.stringify({
      protocolVersion: version,
      kind: `dsh-fs-result-v${version}`,
      operation,
      ok: true,
      result,
    })),
  }
}

async function setup(responses: SlarkDeviceTaskResult[], callerProfile?: 'web_dsh_v1') {
  const executeTask = vi.fn(async (_request: SlarkDeviceTaskRequest) => {
    const response = responses.shift()
    if (response === undefined) throw new Error('missing fake response')
    return response
  })
  const ctx = new Context()
  ctx.provide('slarkDevice', { executeTask })
  await ctx.plugin(SlarkRemoteFileSystem, {
    workspaceHandle: 'workspace-1',
    ...(callerProfile === undefined ? {} : { callerProfile }),
  })
  return { ctx, fs: ctx.fs as SlarkRemoteFileSystem, executeTask }
}

describe('SlarkRemoteFileSystem', () => {
  it('projects one virtual POSIX workspace without exposing a device path', async () => {
    const { ctx, fs, executeTask } = await setup([
      success('resolve', { target: { targetKey: 'dshfs:v1:root', displayPath: '.' } }),
      success('resolve', { target: { targetKey: 'dshfs:v1:file', displayPath: 'src/a #.ts' } }),
    ])
    const root = await fs.resolve('.')
    const file = await fs.resolve('src/a #.ts')

    expect(root.displayPath).toBe('/workspace/workspace-1')
    expect(fs.processPath(file)).toBe('/workspace/workspace-1/src/a #.ts')
    expect(fs.fileUrl(file)).toBe('file:///workspace/workspace-1/src/a%20%23.ts')
    expect(fs.contains(root, file)).toBe(true)
    expect(fs.contains(file, root)).toBe(false)
    await expect(fs.resolve('../escape')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(executeTask).toHaveBeenCalledTimes(2)
    expect(executeTask.mock.calls[1]?.[0]).toMatchObject({
      expectedWorkspaceHandle: 'workspace-1',
      capability: 'fs_read',
      operation: 'resolve',
      payload: { protocolVersion: 1, kind: 'dsh-fs-request-v1', operation: 'resolve', path: 'src/a #.ts' },
    })
    await ctx.fiber.dispose()
  })

  it('maps metadata, stable listings, and remote filesystem errors', async () => {
    const { ctx, fs } = await setup([
      success('stat', { info: { version: 'v1', type: 'file', size: 4 } }),
      success('lstat', { info: { version: 'v2', type: 'symlink', size: 3 } }),
      success('list', { entries: [
        { name: 'b', type: 'file', size: 1, version: 'vb', target: { targetKey: 'kb', displayPath: 'dir/b' } },
        { name: 'a', type: 'directory', version: 'va', target: { targetKey: 'ka', displayPath: 'dir/a' } },
      ] }),
      {
        ...success('stat', {}),
        result: new TextEncoder().encode(JSON.stringify({
          protocolVersion: 1,
          kind: 'dsh-fs-result-v1',
          operation: 'stat',
          ok: false,
          error: { code: 'FS_PERMISSION_DENIED', message: 'denied' },
        })),
      },
    ])
    const target = { targetKey: FsTargetKey('key'), displayPath: '/workspace/workspace-1/file' }
    await expect(fs.stat(target)).resolves.toEqual({ version: 'v1', type: 'file', size: 4 })
    await expect(fs.lstat('link')).resolves.toEqual({ version: 'v2', type: 'symlink', size: 3 })
    const entries = await fs.listDir({ targetKey: FsTargetKey('dir'), displayPath: '/workspace/workspace-1/dir' })
    expect(entries.map(entry => entry.name)).toEqual(['a', 'b'])
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await ctx.fiber.dispose()
  })

  it('pages raw reads, preserves split UTF-8, and rejects binary text', async () => {
    const euro = [...new TextEncoder().encode('A€B')]
    const { ctx, fs, executeTask } = await setup([
      success('read', { content: Buffer.from(euro.slice(0, 2)).toString('base64'), encoding: 'base64', version: 'v1', nextOffset: 2, eof: false }),
      success('read', { content: Buffer.from(euro.slice(2)).toString('base64'), encoding: 'base64', version: 'v1', nextOffset: 5, eof: true }),
      success('read', { content: Buffer.from([0, 1]).toString('base64'), encoding: 'base64', version: 'v2', nextOffset: 2, eof: true }),
      success('read', { content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64', version: 'v3', nextOffset: 3, eof: true }),
    ])
    const text = { targetKey: FsTargetKey('text'), displayPath: '/workspace/workspace-1/text' }
    let streamed = ''
    for await (const chunk of await fs.streamText(text)) streamed += chunk
    expect(streamed).toBe('A€B')
    expect(executeTask.mock.calls[1]?.[0].payload).toMatchObject({ offset: 2, expectedVersion: 'v1' })
    await expect(fs.readText(text)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    expect(await fs.readBytes(text, undefined, 3)).toEqual(Uint8Array.from([1, 2, 3]))
    await ctx.fiber.dispose()
  })

  it('preserves guarded and unconditional mutation semantics', async () => {
    const { ctx, fs, executeTask } = await setup([
      success('write', { operation: 'create', version: 'v1', before: null, after: 'new' }),
      success('write', { operation: 'update', version: 'v2', before: 'old', after: 'new' }),
      success('edit', { version: 'v3', before: 'new', after: 'next' }),
      success('edit', { version: 'v4', before: 'next', after: 'last' }),
    ])
    const target = { targetKey: FsTargetKey('key'), displayPath: '/workspace/workspace-1/file' }
    await fs.writeText(target, 'new', { kind: 'createIfAbsent' })
    await fs.writeText(target, 'new')
    await fs.editText(target, { oldString: 'new', newString: 'next', replaceAll: false }, { version: FsVersion('v2') })
    await fs.editText(target, { oldString: 'next', newString: 'last', replaceAll: false })
    await expect(fs.writeText(target, 'denied', undefined, undefined, {
      mode: 'read-only',
      workspaceRoot: '/workspace/workspace-1',
    })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

    expect(executeTask.mock.calls.map(call => call[0].payload)).toEqual([
      expect.objectContaining({ operation: 'write', intent: { kind: 'createIfAbsent' } }),
      expect.objectContaining({ operation: 'write', intent: null }),
      expect.objectContaining({ operation: 'edit', expectedVersion: 'v2' }),
      expect.objectContaining({ operation: 'edit', expectedVersion: null }),
    ])
    await ctx.fiber.dispose()
  })

  it('uses the Web v2 protocol and rejects unobserved writes and non-NFC paths locally', async () => {
    const { ctx, fs, executeTask } = await setup([
      success('resolve', { target: { targetKey: 'dshfs:v2:file', displayPath: 'src/a.ts' } }, 2),
      success('write', { operation: 'update', version: 'v3', before: 'old', after: 'new' }, 2),
      success('edit', { version: 'v4', before: 'new', after: 'next' }, 2),
    ], 'web_dsh_v1')
    const target = await fs.resolve('src/a.ts')
    await expect(fs.writeText(target, 'new')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: FsVersion('v2') })
    await expect(fs.editText(target, { oldString: 'new', newString: 'next', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await fs.editText(target, { oldString: 'new', newString: 'next', replaceAll: false }, { version: FsVersion('v3') })
    await expect(fs.resolve('e\u0301.txt')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

    const calls = executeTask.mock.calls.map(call => call[0])
    expect(calls.map(call => call.callerProfile)).toEqual([
      'web_dsh_v1', 'web_dsh_v1', 'web_dsh_v1',
    ])
    expect(calls[0]?.payload).toMatchObject({ protocolVersion: 2, kind: 'dsh-fs-request-v2' })
    expect(calls[1]?.payload).toMatchObject({ intent: { kind: 'replaceIfVersion', version: 'v2' } })
    expect(calls[2]?.payload).toMatchObject({ expectedVersion: 'v3' })
    await ctx.fiber.dispose()
  })
})
