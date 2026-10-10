/** Chromium layout regression for stacked dock contributions, using their owning CSS. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { transform } from 'lightningcss'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

async function styles(path: string) {
  const result = transform({ filename: path, code: await readFile(path), cssModules: true })
  return { css: result.code.toString(), name: (key: string) => {
    const value = result.exports?.[key]
    if (!value) throw Error(`Missing fixture CSS class: ${key}`)
    return value.name
  } }
}

it('keeps stacked dock controls and Send reachable in the conversation viewport', async () => {
  const root = await styles('packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css')
  const scope = await styles('packages/client/ui-slark-agent/src/client/ProjectScopeDock.module.css')
  const results = await styles('packages/client/ui-slark-agent/src/client/CollaborationResultsDock.module.css')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const observations: string[] = []
    const projects = Array.from({ length: 20 }, (_, i) => `<label><input type="checkbox">Project ${i}</label>`).join('')
    const agents = Array.from({ length: 20 }, (_, i) => `<p>Agent ${i} · Project ${i}</p>`).join('')
    const replies = Array.from({ length: 20 }, (_, i) => `<p>Original reply ${i}</p>`).join('')
    const dock = `<section class="${scope.name('panel')}">
      <button id="toggle">Slark collaboration</button><div class="${scope.name('body')}">
      <p>Choose project spaces</p><button>Refresh</button>
      <div class="${scope.name('heading')}">Projects</div><div class="${scope.name('rows')}">${projects}</div>
      <button id="more">Load more</button><div class="${scope.name('actions')}">
      <button id="cancel">Cancel</button><button id="apply">Apply scope</button></div>
      <div class="${scope.name('heading')}">Agents</div><div class="${scope.name('rows')}">${agents}</div>
      </div></section><section class="${results.name('panel')}"><strong>Collaboration results</strong>
      <div class="${results.name('records')}">${replies}</div></section>`
    for (const viewport of [{ width: 1228, height: 812 }, { width: 760, height: 500 }]) {
      await page.setViewportSize(viewport)
      await page.setContent(`<style>${root.css}\n${scope.css}\n${results.css}
        html,body { height:100%; margin:0; } body { display:flex; }
        #bar { flex:none; height:180px; display:flex; align-items:end; }
      </style><main class="${root.name('root')}" data-phase="active">
      <header style="height:76px;flex:none">Conversation header</header>
      <div class="${root.name('body')}"><div class="${root.name('scrollBody')}" data-conversation-scroll>
      <div data-slot="conversation.session" style="display:contents"><div class="${root.name('viewArea')}">
      <div data-conversation-composer-overlay>Trajectory</div></div></div>
      <div class="${root.name('composerSeat')}" data-composer-seat>
      <div class="${root.name('composerStack')}"><div class="${root.name('composerDock')}" data-composer-dock>
      <div data-slot="conversation.input.dock" style="display:contents">${dock}</div></div>
      <div id="bar"><button id="send">Send</button></div></div></div></div></div></main>`)
      await page.locator('[data-conversation-scroll]').evaluate((element) => {
        element.style.setProperty('--dsh-conversation-viewport-height', `${element.clientHeight}px`)
      })
      const bounds = async () => page.evaluate(() => {
        const host = document.querySelector('[data-conversation-scroll]')!.getBoundingClientRect()
        const seat = document.querySelector('[data-composer-seat]')!.getBoundingClientRect()
        const dock = document.querySelector('[data-composer-dock]')!
        const send = document.querySelector('#send')!.getBoundingClientRect()
        return { hostTop: host.top, hostBottom: host.bottom, seatTop: seat.top,
          seatBottom: seat.bottom, sendTop: send.top, sendBottom: send.bottom,
          dockOverflows: dock.scrollHeight > dock.clientHeight }
      })
      const good = await bounds()
      expect(good.seatTop).toBeGreaterThanOrEqual(good.hostTop)
      expect(good.seatBottom).toBeLessThanOrEqual(good.hostBottom)
      expect(good.sendTop).toBeGreaterThanOrEqual(good.hostTop)
      expect(good.sendBottom).toBeLessThanOrEqual(good.hostBottom)
      expect(good.dockOverflows).toBe(true)
      for (const id of ['toggle', 'more', 'cancel', 'apply']) {
        await page.locator('#' + id).click()
        const accessible = await page.locator('#' + id).evaluate((element) => {
          const r = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })
        expect(accessible).toBe(true)
      }
      await page.evaluate((css) => {
        const style = document.createElement('style')
        style.id = 'viewport-control'
        style.textContent = css
        document.head.append(style)
      }, `.${root.name('composerStack')} { max-height:none; }`)
      try {
        expect((await bounds()).seatTop).toBeLessThan(good.hostTop)
      } finally { await page.locator('#viewport-control').evaluate((element) => { element.remove() }) }
      expect((await bounds()).seatTop).toBeGreaterThanOrEqual(good.hostTop)
      await page.locator('[data-slot="conversation.input.dock"]').evaluate((element) => { element.replaceChildren() })
      expect(await page.locator('[data-composer-dock]').evaluate(element => getComputedStyle(element).display)).toBe('none')
      expect(await page.locator('[data-composer-seat]').evaluate(element => element.getBoundingClientRect().height)).toBe(180)
      observations.push(`${viewport.width}x${viewport.height}: controls reachable, Send visible, dock scrollable, empty dock has no gap`)
    }
    await expect(observations.join('\n') + '\n').toMatchFileSnapshot(
      join(process.cwd(), 'apps/web/tests/expected/composer-dock-viewport/geometry.expected.txt'))
  } finally { await browser.close() }
})
