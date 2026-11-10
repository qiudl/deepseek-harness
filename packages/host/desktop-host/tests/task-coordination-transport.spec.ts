/** Actual framed Host client/authority; controlled enrollment, worker source selection and signers. */
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'
import { taskFixture } from './task-coordination.test-support.ts'

it('carries a real signed stop Ack and current observation through the actual private Account/frame dispatcher', async () => {
  const f = await taskFixture(), lifetime = new AbortController()
  const identity = { installationId: f.peer.installationId, installationPublicKey: f.peer.publicKey,
    installationPrivateKey: f.installation.privateKey, hostInstanceId: f.peer.hostInstanceId,
    processNonce: f.peer.processNonce, executableSignatureDigest: 'f'.repeat(64), runtimeGeneration: 1, schemaGeneration: 1 }
  const authority = new HostControlAuthority({ host: f.host, identity, now: f.options.now,
    profilePersistenceGeneration: () => 1, collaborationAnalysis: (_profileId, command,
      signal) => f.options.receiver().execute(command, signal),
    taskCoordinationEnvironments: [f.environment], taskCoordinationReceiver: () => f.options.receiver() })
  const session = authority.openSession(f.ownerId, lifetime.signal)
  const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: identity.installationId,
    trustedInstallationPublicKey: identity.installationPublicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    now: f.options.now }, { call: async (frame) => {
    const decoded = decodeHostControlFrame(encodeHostControlFrame(frame))
    const response = await session.handleRequest(decoded)
    return decodeHostControlFrame(encodeHostControlFrame(response))
  }, isConnected: () => !lifetime.signal.aborted,
  close: () => { lifetime.abort(); session.close() } })
  onTestFinished(() =>{  client.close() })
  const transferRequestId = randomUUID(), account = { authorityEnvironmentId: f.account.authorityEnvironmentId,
    accountBindingHandle: f.account.accountBindingHandle, authorityBindingVersion: f.account.authorityBindingVersion,
    issuer: f.account.issuer, subject: f.account.subject }
  const stop = await client.operateTaskCoordination({ ...account, request: f.create({ operation: 'fence', transferRequestId,
    payloadDigest: 'd'.repeat(64) }) })
  expect(stop).toMatchObject({ ok: true, record: { status: 'closed', fenceAck: { transferRequestId } } })
  const receipt = await client.operateTaskCoordination({ ...account, request: f.create({ operation: 'receipt', transferRequestId }) })
  if (!stop.ok || stop.record.status !== 'closed' || !receipt.ok || receipt.record.status !== 'found') throw Error('missing original Ack')
  expect(receipt.record.fenceAck).toEqual(stop.record.fenceAck)
  expect(await client.operateTaskCoordination({ ...account, request: f.create({ operation: 'observe', transferRequestId,
    inventoryId: null, cursor: null, pageSize: 1 }) })).toMatchObject({ ok: true, record: { status: 'observed' } })
})
