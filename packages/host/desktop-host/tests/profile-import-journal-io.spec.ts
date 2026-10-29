import { constants } from 'node:fs'
import { expect, it, vi } from 'vitest'

const openRecord = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  open: openRecord,
}))

const { readImmutableJournalRecord } = await import('../src/profile-import-journal-io.ts')

it('rejects a journal changed while it is being read and closes the handle', async () => {
  const before = {
    isFile: () => true, uid: 42n, nlink: 1n, mode: 0o100600n,
    size: 2n, dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n,
  }
  const handle = {
    stat: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, mtimeNs: 5n }),
    readFile: vi.fn().mockResolvedValue(Buffer.from('{}')),
    close: vi.fn().mockResolvedValue(undefined),
  }
  openRecord.mockResolvedValueOnce(handle)

  await expect(readImmutableJournalRecord('/private/journal.json', 42, 128, {
    unsafe: 'unsafe', changed: 'journal_changed', invalid: 'invalid',
  })).rejects.toThrow('journal_changed')
  expect(openRecord).toHaveBeenCalledWith('/private/journal.json', constants.O_RDONLY | constants.O_NOFOLLOW)
  expect(handle.close).toHaveBeenCalledOnce()
})
