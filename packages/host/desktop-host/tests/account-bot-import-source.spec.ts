import { expect, it, vi } from 'vitest'
import type { DesktopHost } from '../src/desktop-host.ts'
import type { PersonProfileId } from '../src/types.ts'
import type { BotIdentityAccount } from '../src/account-bot-identity.ts'
import { AccountBotImportSourceTransfers } from '../src/account-bot-import-source.ts'
import type { HostBotImportSourceRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from '../src/types.ts'

const account = { ownerId: 'owner', authorityEnvironmentId: 'environment',
  accountBindingHandle: 'binding', authorityBindingVersion: 1,
  issuer: 'issuer', subject: 'subject' } as BotIdentityAccount
const scope = { source_digest: 'a'.repeat(64),
  session_id: 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', target_device_id: 'm5max' }
const operationId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const transferId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const open = { kind: 'open' as const, operationId, sourceDigest: scope.source_digest,
  sessionId: scope.session_id }
const opened = { version: 1 as const, transferId, operationId,
  sessionId: scope.session_id, eventDigest: 'e'.repeat(64), eventCount: 0, totalBytes: 2 }
const next = { kind: 'next' as const, operationId, transferId, offset: 0 }
const page = { ...opened, offset: 0, contentBase64: 'W10=', nextOffset: null }
const signal = new AbortController().signal

function host() {
  const value: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'> = {
    authorizeCollaborationRegistration: vi.fn(),
    authorizeAccountModelText: vi.fn(() => 'profile' as PersonProfileId),
  }
  return value
}

it('rechecks the independent grant after the Worker read and releases no revoked page', async () => {
  let allowed = true
  const grant = vi.fn(async () => { if (!allowed) throw new HostAuthorityError('unauthorized') })
  const worker = vi.fn(async () => { allowed = false; return opened })
  const transfers = new AccountBotImportSourceTransfers(host(), worker, grant)
  await expect(transfers.run(account, scope, open, signal)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(grant).toHaveBeenCalledTimes(2)
  expect(worker).toHaveBeenCalledTimes(1)
  await expect(transfers.run(account, scope, next, signal)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(worker).toHaveBeenCalledTimes(1)
})

it('pins each page to the source, target device, event digest and sequential offset', async () => {
  const grant = vi.fn(async () => {})
  const worker = vi.fn(async (_profileId: string, request: HostBotImportSourceRequest) =>
    request.kind === 'open' ? opened : request.kind === 'next' ? page : { version: 1 as const, closed: true as const })
  const transfers = new AccountBotImportSourceTransfers(host(), worker, grant)
  expect(await transfers.run(account, scope, open, signal)).toEqual(opened)
  await expect(transfers.run(account, { ...scope, target_device_id: 'boston' }, next, signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  await expect(transfers.run(account, scope, { ...next, offset: 1 }, signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(await transfers.run(account, scope, next, signal)).toEqual(page)
  await expect(transfers.run(account, scope, next, signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(worker).toHaveBeenCalledTimes(2)
})

it('rejects a changed event digest before returning the next page', async () => {
  const worker = vi.fn(async (_profileId: string, request: HostBotImportSourceRequest) =>
    request.kind === 'open' ? opened : request.kind === 'next'
      ? { ...page, eventDigest: 'f'.repeat(64) } : { version: 1 as const, closed: true as const })
  const transfers = new AccountBotImportSourceTransfers(host(), worker, async () => {})
  await transfers.run(account, scope, open, signal)
  await expect(transfers.run(account, scope, next, signal))
    .rejects.toMatchObject({ code: 'profile_mismatch' })
})

it('bounds simultaneous opens while the worker is awaiting a source snapshot', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let sequence = 0
  const worker = vi.fn(async () => {
    const id = (++sequence).toString(16).padStart(8, '0')
    await gate
    return { ...opened, transferId: `${id}-dddd-dddd-dddd-dddddddddddd` }
  })
  const transfers = new AccountBotImportSourceTransfers(host(), worker, async () => {})
  const first = transfers.run(account, scope, open, signal)
  const second = transfers.run(account, scope, open, signal)
  await expect(transfers.run(account, scope, open, signal))
    .rejects.toMatchObject({ code: 'unauthorized' })
  release()
  await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  expect(worker).toHaveBeenCalledTimes(2)
})
