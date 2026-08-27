import { Context } from '@deepseek-ai/cordis'
import type { SlarkDeviceTaskRequest, SlarkDeviceTaskResult } from '@deepseek-ai/dsh-slark-device-client'
import { describe, expect, it, vi } from 'vitest'
import SlarkRemoteShellExecutor from '../src/index.ts'

function success(operation: string, result: unknown, taskId = '11111111-1111-4111-8111-111111111111'): SlarkDeviceTaskResult {
  return {
    taskId,
    state: 'completed',
    stateVersion: 3,
    authorityVersion: 7,
    terminalCode: null,
    result: new TextEncoder().encode(JSON.stringify({
      protocolVersion: 1,
      kind: 'dsh-shell-result-v1',
      operation,
      ok: true,
      result,
    })),
  }
}

async function setup(handler: (request: SlarkDeviceTaskRequest) => Promise<SlarkDeviceTaskResult>) {
  const executeTask = vi.fn(handler)
  const ctx = new Context()
  ctx.provide('slarkDevice', { executeTask })
  await ctx.plugin(SlarkRemoteShellExecutor, {
    workspaceHandle: 'workspace-1',
    pollIntervalMs: 1,
    maxOutputBytes: 64,
  })
  return { ctx, shell: ctx.shell as SlarkRemoteShellExecutor, executeTask }
}

describe('SlarkRemoteShellExecutor', () => {
  it('maps foreground execution onto the unchanged ShellExecutor contract', async () => {
    const { ctx, shell, executeTask } = await setup(async () => success('run', {
      exitCode: 7,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 2_000,
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'err', truncated: false },
    }))
    const spec = shell.resolve({
      command: 'printf out',
      workdir: '/workspace/workspace-1/packages/app',
      timeoutMs: 999_999,
      dshEnv: { DSH_HOME: '/cloud-only' },
    })
    await expect(shell.run(spec)).resolves.toMatchObject({ exitCode: 7, stdout: { text: 'out' } })
    const request = executeTask.mock.calls[0]![0]
    expect(request).toMatchObject({
      expectedWorkspaceHandle: 'workspace-1',
      capability: 'shell_exec',
      operation: 'run',
    })
    expect(request.payload).toMatchObject({
      virtualWorkdir: 'packages/app',
      command: 'printf out',
      timeoutMs: 600_000,
    })
    await ctx.fiber.dispose()
  })

  it('returns a resumable proxy, surfaces remote gaps once and can resume after a cell restart', async () => {
    let polls = 0
    const { ctx, shell, executeTask } = await setup(async (request) => {
      if (request.operation === 'start') {
        return success('start', { opaqueProcessId: 'dshp-process-1', status: 'running' }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      }
      if (request.operation === 'poll') {
        polls += 1
        return success('poll', polls === 1
          ? {
            opaqueProcessId: 'dshp-process-1', status: 'running', exitCode: null, signal: null,
            delta: 'tail', lossy: true, availableFromSeq: 3, nextOutputSeq: 6,
          }
          : {
            opaqueProcessId: 'dshp-process-1', status: 'completed', exitCode: 0, signal: null,
            delta: '', lossy: false, availableFromSeq: 3, nextOutputSeq: 6,
          })
      }
      throw new Error(`unexpected ${request.operation}`)
    })
    const process = shell.start(shell.resolve({ command: 'long-task' }))
    await process.done
    expect(process.readOutput()).toEqual({ delta: 'tail', lossy: true })
    expect(process.readOutput()).toEqual({ delta: '', lossy: false })
    expect(process.status).toBe('completed')
    const snapshot = process.snapshot()
    expect(snapshot).toEqual({
      startTaskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      opaqueProcessId: 'dshp-process-1',
      afterOutputSeq: 6,
    })

    polls = 1
    const resumed = shell.resumeProcess(snapshot)
    await resumed.done
    expect(resumed.status).toBe('completed')
    expect(executeTask.mock.calls.filter(call => call[0].operation === 'start')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('kills a remote process idempotently without waiting for async initialization', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    const { ctx, shell, executeTask } = await setup(async (request) => {
      if (request.operation === 'start') {
        await startGate
        return success('start', { opaqueProcessId: 'dshp-process-2', status: 'running' })
      }
      if (request.operation === 'kill') {
        return success('kill', { opaqueProcessId: 'dshp-process-2', killed: true })
      }
      if (request.operation === 'poll') {
        return success('poll', {
          opaqueProcessId: 'dshp-process-2', status: 'killed', exitCode: null, signal: 'SIGTERM',
          delta: '', lossy: false, availableFromSeq: 1, nextOutputSeq: 0,
        })
      }
      throw new Error(`unexpected ${request.operation}`)
    })
    const process = shell.start(shell.resolve({ command: 'long-task' }))
    expect(process.kill()).toBe(true)
    expect(process.kill()).toBe(false)
    releaseStart()
    await process.done
    expect(executeTask.mock.calls.some(call => call[0].operation === 'kill')).toBe(true)
    await ctx.fiber.dispose()
  })
})
