/** REQ-20261011-0002: assembled desktop tabs and phone Web list/chat navigation. */
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

it('shows the same Session in collaboration and keeps the phone list beneath chat', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1280, height: 900 })
    const tripwire = watchConsole(page)
    await page.addInitScript(() => {
      Reflect.set(window, '__DSH_DESKTOP_HOST__', {
        collaborationScopeAvailable: true, collaborationExecutionAvailable: true,
        collaborationWorkspace: async ({ workspace_id }: { workspace_id: string }) => ({ ok: true,
          value: { workspace_id, version: '1', selected_project_ids: [], items: [], next_cursor: null } }),
        collaborationPending: async () => ({ ok: false, errorCode: 'collaboration_result_unavailable' }),
        collaborationDeliveries: async () => ({ ok: true, value: { deliveries: [] } }),
        collaborationConversations: async () => {
          const value: unknown = JSON.parse(
            window.localStorage.getItem('__req0002_conversations') ?? '{"items":[],"global_pending_count":0}',
          )
          return { ok: true, value }
        },
      })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'collaboration-phone')
    const workspace = scaffold.ctx.workspaceRegistry.list().find(item => item.path.endsWith('/collaboration-phone'))
    const sessionId = workspace?.sessionIds[0]
    if (!workspace || !sessionId) throw Error('collaboration test Session missing')
    await page.evaluate((value) => { window.localStorage.setItem('__req0002_conversations', JSON.stringify(value)) }, {
      items: [{ workspace_id: workspace.id, session_id: sessionId, first_source_at: '1', last_activity_at: '2',
        source_count: 1, pending_count: 2, planning_count: 0, running_count: 0, issue_count: 0,
        first_pending_digest: 'a'.repeat(64), pinned: false, archived: false }],
      global_pending_count: 2,
    })
    await page.reload({ waitUntil: 'load' })
    const collaborationTab = page.getByRole('tab', { name: /Collaboration/ })
    await expect.poll(() => collaborationTab.textContent()).toContain('2')
    await collaborationTab.click()
    const list = page.getByRole('region', { name: 'Collaboration conversations' })
    await list.waitFor()
    await expect.poll(() => list.getByText('2 items need attention').count()).toBe(1)

    await page.setViewportSize({ width: 390, height: 844 })
    const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' })
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await mobileNav.waitFor()
    await mobileNav.getByRole('button', { name: /Collaboration/ }).click()
    await list.getByRole('button', { name: /2 items need attention/ }).click()
    await page.locator('[data-mobile-section="chat"]').waitFor()
    const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
    await composer.waitFor()
    await composer.focus()
    await page.setViewportSize({ width: 390, height: 520 })
    await expect.poll(async () => {
      const box = await composer.boundingBox()
      return box ? box.y + box.height <= 520 : false
    }).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('slark-scope-toggle').click()
    await page.getByTestId('slark-scope-panel').waitFor()
    const sheet = page.locator('[data-sidebar-right-collaboration][data-sidebar-right-open]')
    await sheet.waitFor()
    expect(await sheet.boundingBox()).toMatchObject({ x: 0, width: 390 })
    await page.getByTestId('slark-scope-cancel').click()
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: /Collaboration/ }).click()
    await page.locator('[data-mobile-section="collaboration"]').waitFor()
    expect(await list.getByText('2 items need attention').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser.close()
  }
})
