import { expect, it } from 'vitest'
import { ProfileImportActivity } from '../src/profile-import-activity.ts'

it('drains work admitted before a fence and rejects work admitted after it', async () => {
  let fenced = false
  const activity = new ProfileImportActivity(() => { if (fenced) throw Error('fenced') })
  let finish!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  const running = activity.run('profile-a', () => held)
  fenced = true
  await expect(activity.run('profile-a', async () => undefined)).rejects.toThrow('fenced')
  let settled = false
  const drain = activity.settled('profile-a').then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish()
  await Promise.all([running, drain])
  expect(settled).toBe(true)
  await expect(activity.settled('profile-a')).resolves.toBeUndefined()
})

it('waits for every task already running under the same Profile', async () => {
  const activity = new ProfileImportActivity(() => {})
  let finishFirst!: () => void
  let finishSecond!: () => void
  const first = activity.run('profile-a', () => new Promise<void>((resolve) => { finishFirst = resolve }))
  const second = activity.run('profile-a', () => new Promise<void>((resolve) => { finishSecond = resolve }))
  let settled = false
  const drain = activity.settled('profile-a').then(() => { settled = true })
  finishFirst()
  await first
  await Promise.resolve()
  expect(settled).toBe(false)
  finishSecond()
  await Promise.all([second, drain])
  expect(settled).toBe(true)
})
