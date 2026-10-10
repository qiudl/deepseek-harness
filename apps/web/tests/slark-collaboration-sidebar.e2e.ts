/** REQ-20260930-0004: shipped browser/sidebar/input owners with an external Desktop directory fixture. */
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from './support.ts'

it.each([1680, 767])('manages Slark scope in the existing sidebar and returns a directory mention to the original composer (%s px)', async (width) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    await page.setViewportSize({ width, height: 1000 })
    const tripwire = watchConsole(page)
    await page.addInitScript(() => {
      let selected: readonly string[] = [], version = 0
      const observed = { applies: [] as (readonly string[])[], submissions: 0 }
      Reflect.set(window, '__SLARK_SIDEBAR_TEST__', observed)
      Reflect.set(window, '__DSH_DESKTOP_HOST__', {
        collaborationScopeAvailable: true, collaborationExecutionAvailable: true,
        collaborationWorkspace: async ({ workspace_id, operation }: { workspace_id: string
          operation: { kind: string; selected_project_ids?: readonly string[] } }) => {
          if (operation.kind === 'apply') {
            selected = operation.selected_project_ids ?? []
            observed.applies.push([...selected]); version++
          }
          if (operation.kind === 'get' || operation.kind === 'apply') return { ok: true,
            value: { workspace_id, version: String(version), selected_project_ids: selected } }
          if (operation.kind === 'projects') return { ok: true, value: { items: [
            { project_id: 'product', project_name: 'Product' },
            { project_id: 'engineering', project_name: 'Engineering' },
          ], next_cursor: null } }
          return { ok: true, value: { items: selected.includes('product') ? [{ project_id: 'product', project_name: 'Product',
            agent_id: 'guide', agent_name: 'Guide', available: true, reason_code: 'ready', capability_snapshot: 'a'.repeat(64) }] : [],
          scope_version: String(version), next_cursor: null } }
        },
        collaborationPending: async () => ({ ok: false, errorCode: 'collaboration_result_unavailable' }),
        collaborationDeliveries: async () => ({ ok: true, value: { deliveries: [] } }),
        collaborationSubmit: async () => { observed.submissions++; return { ok: false } },
        collaborationClarify: async () => { observed.submissions++; return { ok: false } },
      })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, `sidebar-${width}`)
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await writeComposerDraft(page, input, 'Check login ')
    const launcher = page.getByTestId('slark-scope-toggle')
    await launcher.waitFor()
    expect(await page.getByTestId('slark-scope-panel').count()).toBe(0)
    await launcher.click()
    const panel = page.getByTestId('slark-scope-panel')
    await panel.waitFor()
    expect(await panel.locator('[data-composer-input]').count()).toBe(0)
    await panel.getByRole('checkbox', { name: 'Product', exact: true }).check()
    await panel.getByRole('checkbox', { name: 'Engineering', exact: true }).check()
    await panel.getByTestId('slark-scope-apply').click()
    await expect.poll(() => panel.getByTestId('slark-scope-mention-product-guide').isEnabled()).toBe(true)
    expect(await input.textContent()).toBe('Check login ')
    await panel.getByTestId('slark-scope-clear').click()
    await panel.getByTestId('slark-scope-cancel').click()
    await panel.waitFor({ state: 'hidden' })
    expect(await input.textContent()).toBe('Check login ')
    await launcher.click()
    await panel.waitFor()
    await expect.poll(() => panel.getByRole('checkbox', { name: 'Product', exact: true }).isChecked()).toBe(true)
    expect(await panel.getByRole('checkbox', { name: 'Engineering', exact: true }).isChecked()).toBe(true)
    expect(await page.getByTestId('slark-scope-panel').count()).toBe(1)
    if (width === 767) {
      expect(await page.locator('[data-sidebar-right-panel="fullscreen"]').count()).toBe(1)
    }
    await expect.poll(() => panel.getByTestId('slark-scope-mention-product-guide').isEnabled()).toBe(true)
    await panel.getByTestId('slark-scope-mention-product-guide').click()
    await expect.poll(() => input.textContent()).toBe('Check login @Guide · Product ')
    await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
    if (width === 767) await panel.waitFor({ state: 'hidden' })
    else expect(await panel.isVisible()).toBe(true)
    const observed: unknown = await page.evaluate(() => {
      const value: unknown = Reflect.get(window, '__SLARK_SIDEBAR_TEST__')
      return value
    })
    expect(observed).toEqual({ applies: [['product', 'engineering']], submissions: 0 })
    expect(scaffold.ctx.sessions.list().flatMap(session => session.snapshotEvents())
      .filter(event => event.type === 'user/message')).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser.close()
  }
})
