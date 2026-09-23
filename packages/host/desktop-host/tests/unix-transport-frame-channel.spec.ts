import { EventEmitter } from 'node:events'
import { generateKeyPairSync, sign } from 'node:crypto'
import type { Socket } from 'node:net'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostInspectSignaturePayload,
  HOST_CONTROL_MAX_FRAME_BYTES,
  type HostControlCapability,
  type HostControlFrame,
  type HostInspectRequest,
  type HostInspectResult,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it } from 'vitest'
import { UnixHostClient } from '../src/unix-transport.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('base64url')
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
const digest = '1'.repeat(64)
const binding = {
  authorityEnvironmentId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181',
  accountBindingHandle: 'binding:opaque',
  authorityBindingVersion: 1,
}
const capabilities = [
  'host.inspect', 'profile.lease_close', 'profile.ensure', 'profile.ensure_account_token',
  'profile.bootstrap_local', 'profile.open', 'profile.open_local', 'profile.restore', 'profile.restore_local',
  'profile.status', 'profile.view_activate',
].sort() as HostControlCapability[]

function inspection(request: HostInspectRequest): HostInspectResult {
  const unsigned: HostInspectResult = {
    version: 1, type: 'result', request_id: request.request_id, method: 'host.inspect', result: {
      protocol_version: 1, host_instance_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120' as never,
      installation_id: installationId as never, installation_public_key: publicKey as never,
      runtime_generation: 5, schema_generation: 1,
      process_nonce: '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q' as never,
      capabilities, challenge_signature: 'A'.repeat(86) as never, executable_signature_digest: digest as never,
    },
  }
  return { ...unsigned, result: { ...unsigned.result, challenge_signature: sign(null,
    encodeHostInspectSignaturePayload(request, unsigned), keys.privateKey).toString('base64url') as never } }
}

class FakeSocket extends EventEmitter {
  destroyed = false
  onWrite: (frame: HostControlFrame, bytes: Buffer) => void = () => undefined

  write(value: Uint8Array | string): boolean {
    const bytes = Buffer.from(value)
    this.onWrite(decodeHostControlFrame(bytes.toString('utf8')), bytes)
    return true
  }

  destroy(): this {
    if (this.destroyed) return this
    this.destroyed = true
    queueMicrotask(() => { this.emit('close') })
    return this
  }
}

async function connectedSocket(): Promise<{ client: UnixHostClient; socket: FakeSocket }> {
  const socket = new FakeSocket()
  socket.onWrite = (frame) => {
    if (frame.method === 'host.inspect') {
      queueMicrotask(() => { socket.emit('data', Buffer.from(encodeHostControlFrame(inspection(frame as HostInspectRequest)))) })
    }
  }
  const pending = UnixHostClient.connectNamedPipe({ socketPath: 'fixture', trustedInstallationId: installationId,
    trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: digest, now: () => 1_000 },
  undefined, () => socket as unknown as Socket)
  queueMicrotask(() => { socket.emit('connect') })
  return { client: await pending, socket }
}

describe('Unix frame channel failure containment', () => {
  it('rejects pending and later calls after a socket error', async () => {
    const { client, socket } = await connectedSocket()
    const pending = client.getProfileStatus(binding)
    socket.emit('error', new Error('transport failed'))
    await expect(pending).rejects.toThrow('transport failed')
    await expect(client.getProfileStatus(binding)).rejects.toThrow('transport failed')
    socket.emit('close')
  })

  it('destroys a pending call on cancellation and preserves a non-Error abort reason', async () => {
    const { client, socket } = await connectedSocket()
    const controller = new AbortController()
    const pending = client.getProfileStatus({ ...binding, signal: controller.signal })
    controller.abort('cancelled')
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    expect(socket.destroyed).toBe(true)

    const connected = await connectedSocket()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort('before-call')
    await expect(connected.client.getProfileStatus({ ...binding, signal: alreadyAborted.signal }))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(connected.socket.destroyed).toBe(true)

    const preAborted = new AbortController()
    preAborted.abort('before-connect')
    const waiting = UnixHostClient.connectNamedPipe({ socketPath: 'fixture', trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: digest }, preAborted.signal,
    () => new FakeSocket() as unknown as Socket)
    await expect(waiting).rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each([
    ['oversized unterminated input', (socket: FakeSocket) => socket.emit('data', Buffer.alloc(HOST_CONTROL_MAX_FRAME_BYTES + 2, 0x61))],
    ['oversized line', (socket: FakeSocket) => socket.emit('data', Buffer.concat([
      Buffer.alloc(HOST_CONTROL_MAX_FRAME_BYTES + 1, 0x61), Buffer.from('\n'),
    ]))],
    ['malformed frame', (socket: FakeSocket) => socket.emit('data', Buffer.from('{}\n'))],
  ])('destroys the channel for %s', async (_name, corrupt) => {
    const { client, socket } = await connectedSocket()
    const pending = client.getProfileStatus(binding)
    corrupt(socket)
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    expect(socket.destroyed).toBe(true)
  })

  it('rejects unsolicited responses and inbound requests on a client-only channel', async () => {
    for (const inbound of ['response', 'request'] as const) {
      const { client, socket } = await connectedSocket()
      socket.onWrite = (frame) => {
        if (inbound === 'request') {
          queueMicrotask(() => { socket.emit('data', Buffer.from(encodeHostControlFrame(frame))) })
        } else {
          queueMicrotask(() => { socket.emit('data', Buffer.from(encodeHostControlFrame({
            version: 1, type: 'result', request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3111' as never,
            method: 'profile.status', result: { state: 'unbound' },
          }))) })
        }
      }
      await expect(client.getProfileStatus(binding)).rejects.toMatchObject({ code: 'unavailable' })
      expect(socket.destroyed).toBe(true)
    }
  })
})
