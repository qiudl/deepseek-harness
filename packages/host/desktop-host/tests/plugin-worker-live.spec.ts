import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import { waitForPluginRuntime } from '../src/plugin-runtime-ack.ts'

it.runIf(process.env.HOST_PLUGIN_LIVE_WORKER === '1')('starts the shipped CLI web worker and reads its private synthetic Session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-live-plugin-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  initProfile(join(root, 'profiles/web'), PROFILE_TEMPLATES.web!.bundles)
  const sessionId = SessionId('req0013-live-synthetic')
  const storage = new Context()
  await storage.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  try {
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId,
      createdAt: 1, cwd: '/synthetic', isSeeded: false }
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
        data: { id: MessageId('req0013-message'), role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'REQ0013_LIVE_WORKER_SYNTHETIC' }] } },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const writer = await storage.sessionPersistence.create(header)
    try { await writer.append(events) }
    finally { await writer.close() }
  } finally { await storage.fiber.dispose() }
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath,
    dshEntrypointPath: fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url)), readyTimeoutMs: 30_000 })
  const worker = await factory.create({ profileId: 'live-fixture', profileRoot: root, credentialHandle: 'fixture', pluginRoots: [],
    env: { DSH_TELEMETRY_DISABLED: '1' } })
  onTestFinished(async () => { worker.closeNotifications(); worker.abort(); await worker.done })
  expect(worker.viewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:/u)
  if (!worker.viewOrigin || !worker.bootstrapCookie) throw Error('missing worker view')
  await waitForPluginRuntime({ origin: worker.viewOrigin, bootstrapCookie: worker.bootstrapCookie },
    [{ entryId: 'include:tools', moduleName: '@deepseek-ai/dsh-tools' }], AbortSignal.timeout(10_000))
  const denied = await fetch(`${worker.viewOrigin}/internal/desktop-memory-sessions`, {
    method: 'POST', headers: { authorization: 'Bearer invalid' }, body: JSON.stringify({ after: null }),
  })
  expect(denied.status).toBe(403)
  await denied.body?.cancel()
  const sessions = await worker.listMemorySessions?.(null, AbortSignal.timeout(10_000))
  expect(sessions?.items).toHaveLength(1)
  expect(sessions?.items[0]?.sessionId).toBe(sessionId)
  expect(sessions?.items[0]?.revision).toBeTruthy()
  const snapshot = await worker.readMemorySession?.(sessionId, AbortSignal.timeout(10_000))
  expect(snapshot?.revision).toBe(sessions?.items[0]?.revision)
  expect(snapshot?.text).toContain('REQ0013_LIVE_WORKER_SYNTHETIC')
}, 60_000)
