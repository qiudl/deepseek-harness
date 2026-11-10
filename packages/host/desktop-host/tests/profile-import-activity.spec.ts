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
