import {
  HOST_CONTROL_MAX_FRAME_BYTES,
  decodeHostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import { WindowsNamedPipeFrameChannel } from '../src/windows-named-pipe-frame-channel.ts'

const inspectSource = '{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3110","method":"host.inspect","params":{"challenge":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3111","supported_versions":[1]}}\n'
const inspectFrame = decodeHostControlFrame(inspectSource)

function io(chunks: Array<Buffer | null>) {
  const writes: Buffer[] = []
  return {
    writes,
    bindings: {
      read: vi.fn(async () => chunks.shift() ?? null),
      writeFrame: vi.fn(async (_handle: bigint, frame: Buffer) => { writes.push(Buffer.from(frame)) }),
    },
  }
}

describe('Windows named-pipe protocol frame channel', () => {
  it('reassembles one canonical frame across arbitrary ReadFile boundaries', async () => {
    const source = Buffer.from(inspectSource)
    const fixture = io([source.subarray(0, 7), source.subarray(7, 41), source.subarray(41)])
    const channel = new WindowsNamedPipeFrameChannel(91n, fixture.bindings)
    await expect(channel.readFrame()).resolves.toEqual(inspectFrame)
    expect(fixture.bindings.read).toHaveBeenCalledTimes(3)
  })

  it('retains a second frame already returned by the same native read', async () => {
    const fixture = io([Buffer.from(inspectSource + inspectSource)])
    const channel = new WindowsNamedPipeFrameChannel(91n, fixture.bindings)
    await expect(channel.readFrame()).resolves.toEqual(inspectFrame)
    await expect(channel.readFrame()).resolves.toEqual(inspectFrame)
    expect(fixture.bindings.read).toHaveBeenCalledOnce()
  })

  it('distinguishes clean EOF from a truncated frame', async () => {
    await expect(new WindowsNamedPipeFrameChannel(91n, io([null]).bindings).readFrame())
      .resolves.toBeNull()
    const truncated = new WindowsNamedPipeFrameChannel(91n, io([Buffer.from('{"version":1'), null]).bindings)
    await expect(truncated.readFrame()).rejects.toThrow('truncated Windows named-pipe frame')
  })

  it('rejects oversized and malformed frames before handing them to Host business logic', async () => {
    const oversized = new WindowsNamedPipeFrameChannel(
      91n,
      io([Buffer.alloc(HOST_CONTROL_MAX_FRAME_BYTES + 1, 0x61)]).bindings,
    )
    await expect(oversized.readFrame()).rejects.toThrow('oversized Windows named-pipe frame')

    const malformed = new WindowsNamedPipeFrameChannel(91n, io([Buffer.from('{}\n')]).bindings)
    await expect(malformed.readFrame()).rejects.toThrow('invalid Windows named-pipe frame')
  })

  it('rejects empty or over-capacity adapter chunks instead of spinning or growing memory', async () => {
    await expect(new WindowsNamedPipeFrameChannel(91n, io([Buffer.alloc(0)]).bindings).readFrame())
      .rejects.toThrow('invalid Windows named-pipe chunk')

    const prefix = Buffer.alloc(HOST_CONTROL_MAX_FRAME_BYTES, 0x61)
    const overCapacity = io([prefix, Buffer.from('x\n')])
    await expect(new WindowsNamedPipeFrameChannel(91n, overCapacity.bindings).readFrame())
      .rejects.toThrow('invalid Windows named-pipe chunk')
    expect(overCapacity.bindings.read).toHaveBeenNthCalledWith(2, 91n, 1)
  })

  it('writes the shared codec canonical bytes and serializes concurrent responses', async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const writes: string[] = []
    const bindings = {
      read: vi.fn(async () => null),
      writeFrame: vi.fn(async (_handle: bigint, frame: Buffer) => {
        writes.push(frame.toString('utf8'))
        if (writes.length === 1) await first
      }),
    }
    const channel = new WindowsNamedPipeFrameChannel(91n, bindings)
    const one = channel.send(inspectFrame)
    const two = channel.send(inspectFrame)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(writes).toEqual([inspectSource])
    releaseFirst?.()
    await expect(Promise.all([one, two])).resolves.toEqual([undefined, undefined])
    expect(writes).toEqual([inspectSource, inspectSource])
  })

  it('rejects concurrent reads so two consumers cannot reorder one connection', async () => {
    let release: ((chunk: Buffer) => void) | undefined
    const pending = new Promise<Buffer>((resolve) => { release = resolve })
    const bindings = {
      read: vi.fn(async () => pending),
      writeFrame: vi.fn(async () => undefined),
    }
    const channel = new WindowsNamedPipeFrameChannel(91n, bindings)
    const first = channel.readFrame()
    await expect(channel.readFrame()).rejects.toThrow('concurrent Windows named-pipe read')
    release?.(Buffer.from(inspectSource))
    await expect(first).resolves.toEqual(inspectFrame)
  })
})
