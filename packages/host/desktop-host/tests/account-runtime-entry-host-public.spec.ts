import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import type { RuntimeEntryMetadataAuthorization } from '@deepseek-ai/dsh-host-control-protocol'
import { operateAccountRuntimeEntryAnalysis, operateAccountRuntimeEntryOrigin,
  type AccountRuntimeEntryHostOptions } from '../src/account-runtime-entry-host.ts'

const authorization = (JSON.parse(readFileSync(new URL('../../control-protocol/tests/fixtures/runtime-entry-metadata-authorization-v1.json', import.meta.url), 'utf8')) as {
  value: RuntimeEntryMetadataAuthorization
}).value
const binding = authorization.metadata.binding
const query = { purpose: 'runtime_entry_observe', target: {
  namespace_id: binding.namespaceId, command_id: binding.rootCommandId,
  workspace_id: binding.sourceCoordinates.workspaceId, session_id: binding.sessionId,
  source_message_id: binding.sourceCoordinates.sourceMessageId, source_revision: binding.sourceCoordinates.sourceRevision,
}, selection: { plan_id: 'original-plan', expected_plan_revision: '1', candidate_digest: 'a'.repeat(64),
  task_id: 'original-task', task_revision: '1', task_digest: 'b'.repeat(64), expected_scope_version: '0' },
delivery_id: binding.terminalDeliveryId }
const account = { authorityEnvironmentId: authorization.authorityEnvironmentId, issuer: authorization.accountIssuer,
  subject: authorization.accountSubject, accountBindingHandle: authorization.accountBindingId,
  authorityBindingVersion: authorization.accountBindingVersion }
const analysis = { action: 'root_feedback', purpose: 'runtime_entry', operation: {
  action: 'consumer_read', target: query.target, selection: query.selection, delivery_id: query.delivery_id,
} }

function harness(reply: unknown) {
  const execute = vi.fn(async (_value: unknown, _signal: AbortSignal) => reply)
  const assertCurrent = vi.fn()
  const workerId = '10000000-0000-4000-8000-000000000001'
  const profileId = authorization.metadata.binding.hostProfileId
  const options = {
    host: { withCollaborationAccountRequest: async (_account: unknown, signal: AbortSignal,
      callback: (id: string, active: AbortSignal) => Promise<unknown>) => callback(profileId, signal) },
    receiver: () => ({ workerId, assertCurrent, execute }),
    profileRoot: () => '/tmp', peer: authorization.peer, configuration: {}, keyrings: [], sign: () => '', now: Date.now,
  } as unknown as AccountRuntimeEntryHostOptions
  return { options, execute, assertCurrent, workerId, profileId }
}

it('returns an absent original entry only for a current worker and the requested observation', async () => {
  const h = harness({ entryId: null })
  await expect(operateAccountRuntimeEntryOrigin(h.options, account as never, query, 'private-binding',
    new AbortController().signal)).resolves.toEqual({ purpose: 'runtime_entry_observe', observation: null })
  expect(h.assertCurrent).toHaveBeenCalledTimes(2)
  expect(h.execute).toHaveBeenCalledTimes(1)
  expect(h.execute.mock.calls[0]?.[0]).toMatchObject({ action: 'runtime_entry_locate',
    binding_key: 'private-binding', actualWorkerId: h.workerId, actualAccount: { hostProfileId: h.profileId } })
})

it.each([{ entryId: null, extra: true }, { entryId: 1 }])(
  'rejects a worker locator result that cannot identify an owned entry: %j', async (reply) => {
    const h = harness(reply)
    await expect(operateAccountRuntimeEntryOrigin(h.options, account as never, query, 'private-binding',
      new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
  },
)

it('forwards a metadata read with the current account and rejects a stale worker', async () => {
  const h = harness({ state: 'missing' })
  await expect(operateAccountRuntimeEntryAnalysis(h.options, account as never, analysis, 'private-binding',
    new AbortController().signal)).resolves.toEqual({ state: 'missing' })
  expect(h.assertCurrent).toHaveBeenCalledTimes(2)
  expect(h.execute.mock.calls[0]?.[0]).toMatchObject({ action: 'root_feedback',
    binding_key: 'private-binding', actualWorkerId: h.workerId,
    actualAccount: { hostProfileId: h.profileId } })

  const stale = harness({ state: 'missing' })
  stale.assertCurrent.mockImplementation(() => { throw Error('stale_worker') })
  await expect(operateAccountRuntimeEntryAnalysis(stale.options, account as never, analysis, 'private-binding',
    new AbortController().signal)).rejects.toThrow('stale_worker')
  expect(stale.execute).not.toHaveBeenCalled()
})
