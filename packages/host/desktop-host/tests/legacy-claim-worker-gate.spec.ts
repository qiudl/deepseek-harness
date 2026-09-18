import { describe, expect, it, vi } from 'vitest'
import { LegacyClaimWorkerGate } from '../src/legacy-claim-worker-gate.ts'

describe('legacy model claim worker gate', () => {
  it('blocks starts while fenced and reopens only after a successful claim restart', async () => {
    let pending = false
    const gate = new LegacyClaimWorkerGate(() => pending)
    const dispose = vi.fn(async () => undefined)
    const ensure = vi.fn(async () => undefined)
    await gate.stop('profile', dispose)
    expect(() => { gate.assertOpen('profile') }).toThrow(/unavailable/u)
    await expect(gate.start('profile', ensure, dispose)).rejects.toThrow(/unavailable/u)
    expect(ensure).not.toHaveBeenCalled()
    pending = true
    await expect(gate.start('profile', ensure, dispose, true)).rejects.toThrow(/unavailable/u)
    pending = false
    await gate.start('profile', ensure, dispose, true)
    gate.assertOpen('profile')
    expect(ensure).toHaveBeenCalledOnce()
    await gate.start('profile', ensure, dispose)
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('stops a worker when a pending marker appears during startup', async () => {
    let pending = false
    const gate = new LegacyClaimWorkerGate(() => pending)
    const dispose = vi.fn(async () => undefined)
    await expect(gate.start('profile', async () => { pending = true }, dispose))
      .rejects.toThrow(/unavailable/u)
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => { gate.assertOpen('profile') }).toThrow(/unavailable/u)
    await expect(gate.start('profile', async () => undefined, dispose))
      .rejects.toThrow(/unavailable/u)
  })

  it('keeps a worker fenced when shutdown or claim restart fails', async () => {
    const gate = new LegacyClaimWorkerGate(() => false)
    await expect(gate.stop('profile', async () => { throw Error('stop failed') })).rejects.toThrow('stop failed')
    await expect(gate.start('profile', async () => { throw Error('restart failed') }, async () => undefined, true))
      .rejects.toThrow('restart failed')
    expect(() => { gate.assertOpen('profile') }).toThrow(/unavailable/u)
    await gate.start('profile', async () => undefined, async () => undefined, true)
    gate.assertOpen('profile')
  })

  it('closes a worker if another claim fences the profile during startup', async () => {
    const gate = new LegacyClaimWorkerGate(() => false)
    const dispose = vi.fn(async () => undefined)
    await expect(gate.start('profile', async () => { await gate.stop('profile', dispose) }, dispose))
      .rejects.toThrow(/unavailable/u)
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
