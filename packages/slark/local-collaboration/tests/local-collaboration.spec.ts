import { createServer, type Socket } from 'node:net'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRegistrationMac,
  SlarkLocalCollaboration,
  type SlarkCollaborationContext,
  type SlarkUsageReporter,
} from '../src/index.ts'

const REGISTRATION_ID = '22222222-2222-4222-8222-222222222222'
const CONTEXT_REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const CHALLENGE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

function frames(socket: Socket): AsyncIterable<Record<string, unknown>> {
  let buffer = ''
  const queue: Array<Record<string, unknown>> = []
  let wake: (() => void) | undefined
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      queue.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
      buffer = buffer.slice(newline + 1)
    }
    wake?.()
    wake = undefined
  })
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          const frame = queue.shift()
          if (frame !== undefined) yield frame
          continue
        }
        if (socket.destroyed) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
}

async function nextFrame(iterator: AsyncIterator<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('test ACP connection closed before the next frame')
  return result.value
}

function send(socket: Socket, frame: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(frame)}\n`)
}

describe('SlarkLocalCollaboration', () => {
  it('authenticates, applies enterprise context, acknowledges it, and retains a defensive snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slark-local-'))
    cleanups.push(() => {
      return rm(root, { recursive: true, force: true })
    })
    const socketPath = join(root, 'daemon.sock')
    const keyPath = join(root, 'local-access-key')
    const localAccessKey = `lk_${'a'.repeat(43)}`
    await writeFile(keyPath, localAccessKey, { mode: 0o600 })
    const contextPromise = Promise.withResolvers<SlarkCollaborationContext>()
    const clearedPromise = Promise.withResolvers<undefined>()
    const ackPromise = Promise.withResolvers<Record<string, unknown>>()
    const usageFramePromise = Promise.withResolvers<Record<string, unknown>>()
    const usageAckPromise = Promise.withResolvers<undefined>()
    const sampleId = 'd'.repeat(64)
    let pendingSent = false
    const usageReporter = {
      async pending() {
        if (pendingSent) return []
        pendingSent = true
        return [{
          sample_id: sampleId, source_seq: 7, session_digest: 'e'.repeat(64), turn: 1, step: 1, attempt: 1,
          provider: 'deepseek', model: 'deepseek-chat', uncached_input_tokens: 10, cache_read_tokens: 20,
          cache_write_tokens: 0, output_tokens: 3, usage_state: 'complete', call_terminal: 'completed',
          turn_terminal: 'completed', occurred_at: 1_700_000_000_000, environment_id: 'staging',
          personal_project_id: 'project-1', binding_id: 'binding-1', binding_auth_version: 4,
        }]
      },
      async acknowledge(receivedSampleId: string, sourceSeq: number) {
        expect({ receivedSampleId, sourceSeq }).toEqual({ receivedSampleId: sampleId, sourceSeq: 7 })
        usageAckPromise.resolve(undefined)
      },
      notify() {},
      async wait(signal: AbortSignal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve()
          }, { once: true })
        })
      },
    } as unknown as SlarkUsageReporter

    const server = createServer((socket) => {
      void (async () => {
        const iterator = frames(socket)[Symbol.asyncIterator]()
        const registration = await nextFrame(iterator)
        const descriptor = registration.descriptor as Parameters<typeof createRegistrationMac>[0]['descriptor']
        send(socket, {
          type: 'slark.dsh-local.challenge.v1',
          request_id: registration.request_id,
          challenge: CHALLENGE,
          expires_at: Date.now() + 3_000,
        })
        const proof = await nextFrame(iterator)
        expect(proof).toMatchObject({
          type: 'slark.dsh-local.proof.v1',
          request_id: registration.request_id,
          challenge: CHALLENGE,
          mac: createRegistrationMac({
            localAccessKey,
            requestId: String(registration.request_id),
            pid: Number(registration.pid),
            descriptor,
            challenge: CHALLENGE,
          }),
        })
        send(socket, {
          type: 'slark.dsh-local.acp.initialize.v1',
          request_id: registration.request_id,
          process_nonce: descriptor.process_nonce,
          acp_protocol_version: 1,
          required_capabilities: ['enterprise_collaboration_v2'],
        })
        expect(await nextFrame(iterator)).toMatchObject({
          type: 'slark.dsh-local.acp.ready.v1',
          installation_id: 'dsh-test-installation',
          endpoint_origin: 'http://127.0.0.1:4317',
        })
        send(socket, {
          type: 'slark.dsh-local.accepted.v1',
          request_id: registration.request_id,
          registration_id: REGISTRATION_ID,
          accepted_at: Date.now(),
        })
        send(socket, {
          type: 'slark.dsh-local.acp.context.set.v2',
          request_id: CONTEXT_REQUEST_ID,
          registration_id: REGISTRATION_ID,
          context: {
            environment_id: 'staging',
            user_id: 'user-1',
            enterprise_id: 'ent-1',
            enterprise_name: 'Acme',
            personal_project_id: 'project-1',
            binding_id: 'binding-1',
            binding_auth_version: 4,
            capabilities: ['project_navigation'],
          },
        })
        ackPromise.resolve(await nextFrame(iterator))
        const usageFrame = await nextFrame(iterator)
        usageFramePromise.resolve(usageFrame)
        send(socket, {
          type: 'slark.dsh-local.usage-accepted.v1',
          registration_id: REGISTRATION_ID,
          process_nonce: descriptor.process_nonce,
          sample_id: sampleId,
          source_seq: 7,
        })
        await usageAckPromise.promise
        socket.end()
      })()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    cleanups.push(() => new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    }))

    const collaboration = new SlarkLocalCollaboration({
      socketPath,
      localAccessKeyPath: keyPath,
      installationId: 'dsh-test-installation',
      dshVersion: '1.2.3',
    }, 'http://127.0.0.1:4317', (context) => {
      if (context === undefined) clearedPromise.resolve(undefined)
      else contextPromise.resolve(context)
    }, (error) => {
      contextPromise.reject(error)
    }, usageReporter)
    cleanups.push(() => {
      collaboration.close()
    })
    collaboration.start()

    const context = await contextPromise.promise
    expect(context).toMatchObject({ enterpriseId: 'ent-1', personalProjectId: 'project-1' })
    const acknowledgement = await ackPromise.promise
    expect(acknowledgement).toMatchObject({
      type: 'slark.dsh-local.acp.context.applied.v2',
      request_id: CONTEXT_REQUEST_ID,
      registration_id: REGISTRATION_ID,
    })
    expect(acknowledgement.process_nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await expect(usageFramePromise.promise).resolves.toMatchObject({
      type: 'slark.dsh-local.usage.v1', sample_id: sampleId, source_seq: 7,
      registration_id: REGISTRATION_ID, attempt: 1, environment_id: 'staging',
    })
    await usageAckPromise.promise
    context.capabilities.push('mutated')
    expect(collaboration.current()?.capabilities).toEqual(['project_navigation'])
    expect((await readFile(keyPath, 'utf8')).trim()).toBe(localAccessKey)
    await clearedPromise.promise
    expect(collaboration.current()).toBeUndefined()
  })

  it('rejects a local access key file readable by another POSIX user', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-slark-local-permissions-'))
    cleanups.push(() => {
      return rm(root, { recursive: true, force: true })
    })
    const keyPath = join(root, 'local-access-key')
    await writeFile(keyPath, `lk_${'b'.repeat(43)}`, { mode: 0o600 })
    await chmod(keyPath, 0o644)
    const warning = Promise.withResolvers<Error>()
    const collaboration = new SlarkLocalCollaboration({
      socketPath: join(root, 'daemon.sock'),
      localAccessKeyPath: keyPath,
      installationId: 'dsh-test-installation',
      dshVersion: '1.2.3',
    }, 'http://127.0.0.1:4317', () => {}, (error) => {
      warning.resolve(error)
    })
    cleanups.push(() => {
      collaboration.close()
    })
    collaboration.start()
    await expect(warning.promise).resolves.toMatchObject({
      message: 'Slark local access key file is not an owner-only regular file',
    })
  })
})
