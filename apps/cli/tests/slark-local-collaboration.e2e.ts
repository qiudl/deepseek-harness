/** Real shipped Web-profile composition with the optional Slark local ACP row. */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createRegistrationMac } from '@deepseek-ai/dsh-slark-local-collaboration'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const builtFrontend = join(repoRoot, 'apps/web/dist/index.html')
const CHALLENGE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const REGISTRATION_ID = '22222222-2222-4222-8222-222222222222'
const CONTEXT_REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function frameIterator(socket: Socket): AsyncIterator<Record<string, unknown>> {
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
    async next() {
      while (queue.length === 0 && !socket.destroyed) {
        await new Promise<void>((resolve) => { wake = resolve })
      }
      const frame = queue.shift()
      return frame === undefined
        ? { done: true, value: undefined }
        : { done: false, value: frame }
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

function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  child.kill('SIGTERM')
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve()
    })
  })
}

describe.skipIf(!existsSync(builtBin) || !existsSync(builtFrontend))(
  'Slark local collaboration (real built Web profile)',
  () => {
    it('serves the formal UI and acknowledges context through the shipped Loader tree', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-slark-composition-'))
      cleanups.push(() => {
        return rm(root, { recursive: true, force: true })
      })
      const socketPath = join(root, 'slark.sock')
      const keyPath = join(root, 'local-access-key')
      const localAccessKey = `lk_${'c'.repeat(43)}`
      await writeFile(keyPath, localAccessKey, { mode: 0o600 })
      const accepted = Promise.withResolvers<{ endpointOrigin: string }>()
      const acknowledged = Promise.withResolvers<Record<string, unknown>>()
      const server = createServer((socket) => {
        void (async () => {
          const frames = frameIterator(socket)
          const registration = await nextFrame(frames)
          const descriptor = registration.descriptor as Parameters<typeof createRegistrationMac>[0]['descriptor']
          send(socket, {
            type: 'slark.dsh-local.challenge.v1',
            request_id: registration.request_id,
            challenge: CHALLENGE,
            expires_at: Date.now() + 3_000,
          })
          expect(await nextFrame(frames)).toMatchObject({
            type: 'slark.dsh-local.proof.v1',
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
          expect(await nextFrame(frames)).toMatchObject({ type: 'slark.dsh-local.acp.ready.v1' })
          send(socket, {
            type: 'slark.dsh-local.accepted.v1',
            request_id: registration.request_id,
            registration_id: REGISTRATION_ID,
            accepted_at: Date.now(),
          })
          accepted.resolve({ endpointOrigin: descriptor.endpoint_origin })
          send(socket, {
            type: 'slark.dsh-local.acp.context.set.v2',
            request_id: CONTEXT_REQUEST_ID,
            registration_id: REGISTRATION_ID,
            context: {
              environment_id: 'staging',
              user_id: 'user-1',
              enterprise_id: 'enterprise-1',
              enterprise_name: 'Enterprise One',
              personal_project_id: 'personal-1',
              binding_id: 'binding-1',
              binding_auth_version: 1,
              capabilities: ['project_navigation'],
            },
          })
          acknowledged.resolve(await nextFrame(frames))
        })().catch((error: unknown) => {
          acknowledged.reject(error)
        })
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

      const child = spawn(process.execPath, [builtBin, 'web', '--port', '0', '--no-open'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-composition-no-call',
          DSH_AGENTS_HOME: join(root, '.agents'),
          DSH_HOME: join(root, '.dsh'),
          DSH_TELEMETRY_DISABLED: '1',
          SLARK_DSH_LOCAL_ACCESS_KEY_PATH: keyPath,
          SLARK_DSH_LOCAL_INSTALLATION_ID: 'dsh-composition-test',
          SLARK_DSH_LOCAL_SOCKET: socketPath,
        },
      })
      cleanups.push(() => {
        return terminate(child)
      })
      let stderr = ''
      const childStderr = child.stderr
      if (childStderr === null) throw new Error('formal Web profile stderr pipe was not created')
      childStderr.setEncoding('utf8')
      childStderr.on('data', (chunk: string) => { stderr += chunk })

      const { endpointOrigin } = await Promise.race([
        accepted.promise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`formal Web profile did not register; stderr:\n${stderr}`))
          }, 15_000)
        }),
      ])
      const response = await fetch(endpointOrigin)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<title>DSH Local Build</title>')
      expect(await acknowledged.promise).toMatchObject({
        type: 'slark.dsh-local.acp.context.applied.v2',
        request_id: CONTEXT_REQUEST_ID,
        registration_id: REGISTRATION_ID,
      })
    }, 20_000)
  },
)
