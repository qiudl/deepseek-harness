/** Actual original consumer/Account/Main/frame/HTTP/Loader/native/JSONL; source enrollment, model and permits are controlled. */
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseHostRemoteSessionJson, decodeHostControlFrame, encodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { HostControlAuthority, UnixHostClient } from '../../../host/desktop-host/src/unix-transport.ts'
import { ProfileWorkerSupervisor } from '../../../host/desktop-host/src/worker-supervisor.ts'
import { taskFixture } from '../../../host/desktop-host/tests/task-coordination.test-support.ts'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { actualTaskLoader } from './task-coordination-loader.test-support.ts'

it.each(['attached_fence', 'legacy_fence', 'late_attach', 'legacy_before_start', 'prepared_inventory', 'account_revoke', 'ignored_abort', 'clock_expired', 'flush_denied', 'scoped_native_allowed', 'scoped_native_fence', 'replaced_before_batch', 'unsupported_pregrant', 'allowed'] as const)(
  'retains the actual original consumer and final body fence through %s', async (mode) => {
    const f = await taskFixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>(),
      cancelled = Promise.withResolvers<undefined>(), bodyEntered = Promise.withResolvers<undefined>(),
      finishBody = Promise.withResolvers<undefined>()
    let bodyCount = 0, denyFlush = false
    const rt = await actualTaskLoader({ profileId: f.profile.profileId, workerId: f.workerId, environment: f.environment,
      body: async () => { bodyCount++; if (mode === 'flush_denied') denyFlush = true; bodyEntered.resolve(undefined); if (mode === 'ignored_abort') await finishBody.promise; return 'actual isolated effect' } })
    if (mode === 'scoped_native_allowed' || mode === 'scoped_native_fence')
      rt.agent.ctx.tools.setExecutor(new NativeToolExecutor(rt.agent.ctx))
    if (mode === 'unsupported_pregrant') rt.agent.ctx.tools.setExecutor({ describe: () => ({ schemas: [] }),
      execute: async () => { throw Error('unsupported executor reached') } })
    rt.ctx.on('tools/execute', async (exec, next) => {
      entered.resolve(undefined)
      exec.signal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
      await release.promise
      exec.signal = new AbortController().signal
      return next()
    })
    const privateExecute = async (command: Parameters<ProfileWorkerSupervisor['collaborationAnalysis']>[1], signal: AbortSignal) =>
      parseHostRemoteSessionJson(await rt.execute(command, signal))
    const workers = new ProfileWorkerSupervisor(async () => ({ workerId: f.workerId, closeNotifications() {}, abort() {},
      done: Promise.resolve(undefined), collaborationAnalysis: privateExecute }))
    await workers.start({ profileId: f.profile.profileId, profileRoot: rt.directory, credentialHandle: 'controlled-fixture', pluginRoots: [] })
    onTestFinished(() => workers.disposeAll())
    const identity = { installationId: f.peer.installationId, installationPublicKey: f.peer.publicKey,
      installationPrivateKey: f.installation.privateKey, hostInstanceId: f.peer.hostInstanceId, processNonce: f.peer.processNonce,
      executableSignatureDigest: 'f'.repeat(64), runtimeGeneration: 1, schemaGeneration: 1 }
    const authority = new HostControlAuthority({ host: f.host, identity, now: f.options.now,
      profilePersistenceGeneration: () => 1, collaborationAnalysis: (profile, command, signal) =>
        workers.collaborationAnalysis(profile, command, signal),
      rootFeedbackSupported: true, taskCoordinationEnvironments: [f.environment],
      taskCoordinationReceiver: profile => workers.taskCoordinationReceiver(profile) })
    const lifetime = new AbortController(), session = authority.openSession(f.ownerId, lifetime.signal)
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: identity.installationPublicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      now: f.options.now }, { call: async (frame) => {
      const response = await session.handleRequest(decodeHostControlFrame(encodeHostControlFrame(frame)))
      return decodeHostControlFrame(encodeHostControlFrame(response))
    }, isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort(); session.close() } })
    onTestFinished(() =>{  client.close() })
    const account = { authorityEnvironmentId: f.account.authorityEnvironmentId, accountBindingHandle: f.account.accountBindingHandle,
      authorityBindingVersion: f.account.authorityBindingVersion, issuer: f.account.issuer, subject: f.account.subject }
    const scope = { ...f.scope, canonicalRef: { kind: 'dsh_root', namespace_id: rt.root.namespace_id,
      root_task_id: rt.root.root_task_id, root_trace_id: rt.root.root_trace_id } }
    const attachOriginal = async () => {
      const request = f.create({ operation: 'attach', grant: { kind: 'root_execution', scopeId: rt.root.namespace_id,
        originalId: rt.execution.execution_command_id, snapshotDigest: 'e'.repeat(64) }, localExecution: { kind: 'dsh_command',
        commandId: rt.execution.execution_command_id, invocationId: rt.execution.receipt.invocation_id,
        sessionId: rt.agent.id, commandDigest: rt.execution.command_digest } }, scope)
      expect(await client.operateTaskCoordination({ ...account, request })).toMatchObject({ ok: true, record: { status: 'attached' } })
    }
    try {
      if (!['legacy_fence', 'legacy_before_start', 'late_attach'].includes(mode)) await attachOriginal()
      if (mode === 'legacy_before_start' || mode === 'prepared_inventory') {
        const transferRequestId = randomUUID()
        expect(await client.operateTaskCoordination({ ...account, request: f.create({ operation: 'fence', transferRequestId,
          payloadDigest: 'd'.repeat(64) }, scope) })).toMatchObject({ ok: true, record: { status: 'closed' } })
        if (mode === 'prepared_inventory') {
          const inventory = await client.operateTaskCoordination({ ...account, request: f.create({ operation: 'observe',
            transferRequestId, inventoryId: null, cursor: null, pageSize: 50 }, scope) })
          if (!inventory.ok || inventory.record.status !== 'observed') throw Error('missing actual prepared inventory')
          expect(inventory.record.observation.items.some(item => item.kind === 'controller_job'
            && Object.is(item.commandId, rt.execution.execution_command_id) && item.jobId === rt.start.grant.command_id
            && item.state === 'queued' && item.disposition === 'not_started')).toBe(true)
        }
        await expect(client.collaborationAnalysis({ ...account, command: { action: 'root_feedback', operation: rt.start } }))
          .rejects.toThrow()
        expect(bodyCount).toBe(0)
        expect(rt.adapter.requests).toHaveLength(0)
        return
      }
      if (mode === 'replaced_before_batch') {
        rt.adapter.beforeResponse = () => {
          rt.adapter.beforeResponse = undefined
          rt.agent.ctx.tools.setExecutor(new NativeToolExecutor(rt.agent.ctx))
        }
        release.resolve(undefined)
        await expect(client.collaborationAnalysis({ ...account, command: { action: 'root_feedback', operation: rt.start } }))
          .rejects.toThrow()
        expect(bodyCount).toBe(0)
        const journal = await rt.controller.openCollaborationTaskCoordinationJournal()
        expect(journal.jobs(rt.execution.execution_command_id).map(job => job.state)).toEqual(['returned_not_durable'])
        return
      }
      if (mode === 'unsupported_pregrant') {
        await expect(client.collaborationAnalysis({ ...account, command: { action: 'root_feedback', operation: rt.start } }))
          .rejects.toThrow()
        const retained = await rt.controller.collaborationRootConsumption({ action: 'consumer_read', target: rt.start.target, selection: rt.start.selection, delivery_id: rt.start.delivery_id }, new AbortController().signal)
        expect(retained).toMatchObject({ record: { state: 'prepared' } })
        expect(bodyCount).toBe(0)
        expect(rt.adapter.requests).toHaveLength(0)
        return
      }
      if (mode === 'clock_expired') {
        rt.adapter.beforeResponse = () => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse(rt.start.grant.expires_at)) }
        release.resolve(undefined)
      }
      if (mode === 'flush_denied') {
        const originalFlush = rt.ctx.sessions.flush.bind(rt.ctx.sessions)
        vi.spyOn(rt.ctx.sessions, 'flush').mockImplementation((...args) => denyFlush ? Promise.resolve(false) : originalFlush(...args))
        release.resolve(undefined)
      }
      const original = client.collaborationAnalysis({ ...account, command: { action: 'root_feedback', operation: rt.start } })
      let requestSettled = false
      const outcome = original.then((value) => { requestSettled = true; return { ok: true as const, value } },
        (error: unknown) => { requestSettled = true; return { ok: false as const, error } })
      if (mode === 'flush_denied') {
        await outcome
        await rt.agent.whenIdle()
        expect(bodyCount).toBe(1)
        const journal = await rt.controller.openCollaborationTaskCoordinationJournal()
        expect(journal.calls(rt.execution.execution_command_id).map(call => call.state)).toEqual(['returned_not_durable'])
        return
      }
      if (mode === 'clock_expired') {
        await outcome
        await rt.agent.whenIdle()
        expect(bodyCount).toBe(0)
        expect(rt.adapter.requests).toHaveLength(1)
        return
      }
      await Promise.race([entered.promise, outcome.then(() => { throw Error('actual consumer ended before wrapper') })])
      const view = rt.ctx.get('collaborationTaskExecutions')?.read(rt.agent.id, 1)
      expect(view?.commandId).toBe(rt.execution.execution_command_id)
      if (mode === 'ignored_abort') { release.resolve(undefined); await bodyEntered.promise }
      if (mode === 'late_attach') await attachOriginal()
      if (mode === 'account_revoke') {
        f.host.revokeOwner(f.ownerId)
        await cancelled.promise
      } else if (mode !== 'allowed' && mode !== 'scoped_native_allowed') {
        const transferRequestId = randomUUID()
        const result = await client.operateTaskCoordination({ ...account,
          request: f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }, scope) })
        expect(result).toMatchObject({ ok: true, record: { status: 'closed', fenceAck: { transferRequestId } } })
        await cancelled.promise
        const observed = await client.operateTaskCoordination({ ...account, request: f.create({ operation: 'observe', transferRequestId,
          inventoryId: null, cursor: null, pageSize: 50 }, scope) })
        expect(observed).toMatchObject({ ok: true, record: { status: 'observed', observation: {
          coverage: { native: mode === 'legacy_fence' || mode === 'late_attach' ? 'unknown' : 'complete', device: 'unsupported' }, quiescence: mode === 'legacy_fence' || mode === 'late_attach' ? 'unknown' : 'in_flight',
        } } })
        expect(JSON.stringify(observed)).not.toContain('isolated result')
        if (mode === 'late_attach') {
          if (!observed.ok || observed.record.status !== 'observed') throw Error('missing late attachment inventory')
          expect(observed.record.observation.items.some(item => item.kind === 'controller_job'
            && item.jobId === rt.start.grant.consumer_attempt_id && item.state === 'unknown'
            && item.disposition === 'effect_unknown')).toBe(true)
        }
        if (mode === 'ignored_abort') {
          expect(requestSettled).toBe(false)
          if (!observed.ok || observed.record.status !== 'observed') throw Error('missing actual body inventory')
          expect(observed.record.observation.items.some(item => item.kind === 'native_call'
            && item.state === 'body_entered' && item.disposition === 'running')).toBe(true)
        }
      }
      expect(bodyCount).toBe(mode === 'ignored_abort' ? 1 : 0)
      release.resolve(undefined)
      finishBody.resolve(undefined)
      await rt.agent.whenIdle()
      const result = await outcome
      expect(bodyCount).toBe(mode === 'allowed' || mode === 'scoped_native_allowed' || mode === 'ignored_abort' ? 1 : 0)
      if (mode === 'account_revoke') expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      else expect(result.ok).toBe(true)
      expect(rt.ctx.get('collaborationTaskExecutions')?.read(rt.agent.id, 1)).toBeNull()
      expect(await rt.ctx.sessions.flush(rt.agent.session)).toBe(true)
      const stored = await rt.ctx.sessionPersistence.open(rt.agent.id, 'read')
      try {
        const { events } = await stored.read()
        expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
        expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
      } finally { await stored.close() }
      const originalIds = await rt.controller.collaborationRootExecution({ action: 'read', target: rt.target, selection: rt.selection },
        new AbortController().signal)
      expect(originalIds).toEqual(rt.execution)
    } finally { release.resolve(undefined); finishBody.resolve(undefined) }
  })
