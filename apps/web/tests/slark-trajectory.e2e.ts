/** Recorded Session replay with external Main/Source peers; local history remains owned by the real Host. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents, seedSession, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, WEB_FIXTURE_TIME } from './support.ts'
import { AUTO_REVIEW_FIXTURE } from './auto-review-fixture.ts'

const mode = webSnapshotMode()
it.skipIf(mode === 'record')('replays a recorded Session beside its readonly collaboration trajectory after reload', async () => {
  const fixture = await readFile(fileURLToPath(new URL('../../../snapshots/web/auto-review-denial/session.v3.jsonl', import.meta.url)), 'utf8')
  const scaffold = await launchWebScaffold(AUTO_REVIEW_FIXTURE)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const id = await seedSession(scaffold, fixture, 'slark-trajectory-recorded', undefined, { createdAt: WEB_FIXTURE_TIME })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Trajectory fixture')
    await workspace.attachSession(id)
    const originalEvents = await readPersistedEvents(scaffold, id)
    const page = await newEnglishPage(browser)
    await page.clock.setFixedTime(WEB_FIXTURE_TIME)
    let sourceReads = 0, prompts = 0
    await page.route('**/api/session/collaborationSources', async (route) => {
      sourceReads++
      const request = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { items: [{ source: { workspace_id: workspace.id, session_id: id, source_message_id: 'original', source_revision: '1' },
          snapshot_digest: 'a'.repeat(64), original_message: 'Verify the recorded file operation' }] } } }) })
    })
    await page.route('**/api/session/prompt', async (route) => { prompts++; await route.abort() })
    await page.addInitScript(() => {
      const root = { root_task_id: 'root', root_trace_id: 'b'.repeat(32), task_revision: '2', state_version: '3', state: 'active', intent_state: 'active' }
      Reflect.set(window, '__DSH_DESKTOP_HOST__', { collaborationScopeAvailable: true, collaborationPlanningAvailable: true,
        collaborationExecutionAvailable: false,
        collaborationWorkspace: async ({ workspace_id }: { workspace_id: string }) => ({ ok: true,
          value: { workspace_id, version: '1', selected_project_ids: [] } }),
        collaborationDeliveries: async () => ({ ok: true, value: { deliveries: [] } }),
        collaborationRootExecution: async ({ action }: { action: string }) => {
          if (action !== 'trace') throw Error('browsing cannot execute work')
          return { ok: true, value: { root, coverage: 'partial', next_after_seq: null,
            events: [{ event_id: 'settlement', root_seq: 1, task_revision: 1, type: 'execution_observed', phase: 'execution_succeeded',
              occurred_at: '2026-10-07T00:00:00.000Z', recorded_at: '2026-10-07T00:00:00.000Z',
              trace_context: { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, task_revision: 1, attempt_id: 'attempt' } }] } }
        },
      })
    })
    const open = async () => {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
      const group = page.getByRole('treeitem').filter({ has: page.getByText('Trajectory fixture', { exact: true }) }).first()
      await group.waitFor({ timeout: 15000 })
      await group.hover()
      await page.getByRole('button', { name: 'New session in Trajectory fixture', exact: true }).click()
      await page.getByRole('treeitem', { name: 'New Session', exact: true }).waitFor()
      await page.locator(`[data-row-key="session:${id}"]`).click()
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      const panel = page.getByTestId('slark-collaboration-trajectory')
      await panel.getByTestId('slark-trace-load').click()
      await panel.getByText('b'.repeat(32), { exact: true }).waitFor()
      await panel.locator('summary').click()
      expect(await panel.textContent()).toContain('Original task in progress')
      expect(await panel.textContent()).toContain('Remote execution succeeded')
      expect(await page.locator('[data-trajectory-scroll]').count()).toBe(1)
      return captureStableAria(page, '[data-testid="slark-collaboration-trajectory"]', scaffold.workspaceCwd)
    }
    const first = await open()
    const openedEvents = await readPersistedEvents(scaffold, id)
    expect(openedEvents.slice(0, originalEvents.length)).toEqual(originalEvents)
    const coldOpenEvents = openedEvents.slice(originalEvents.length)
    expect(coldOpenEvents).toHaveLength(1)
    expect(coldOpenEvents[0]).toMatchObject({ type: 'session/end-seed', data: {}, seq: originalEvents.length })
    expect(typeof coldOpenEvents[0]?.time).toBe('number')
    const second = await open()
    expect(second).toBe(first)
    expect(sourceReads).toBeGreaterThanOrEqual(2)
    expect(prompts).toBe(0)
    expect(await readPersistedEvents(scaffold, id)).toEqual(openedEvents)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/slark-trajectory/recorded-session.expected.md', import.meta.url)), first, mode)
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})
