/** Browser acceptance for the isolated, same-UI DSH static entry. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const parentOrigin = 'https://staging.ai.pipexerp.com'
const remoteOrigin = 'https://dsh-ui-staging.colorbuyai.com'
const csp = `default-src 'none'; script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${parentOrigin}`
const types: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

it('boots the stock DSH entry through one cross-origin parent port and rejects another framer', async () => {
  const built = mkdtempSync(join(tmpdir(), 'dsh-remote-frame-'))
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', built], {
      cwd: appRoot, env: { ...process.env, VITE_DSH_REMOTE_PARENT_ORIGIN: parentOrigin },
      stdio: 'pipe',
    })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    await context.addCookies([{
      name: 'slark_session_probe', value: 'parent-only', domain: 'staging.ai.pipexerp.com',
      path: '/', secure: true,
    }])
    await context.route(`${remoteOrigin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname
      const file = resolve(built, `.${pathname}`)
      if (!file.startsWith(`${built}${sep}`)) {
        await route.fulfill({ status: 404 })
        return
      }
      try {
        await route.fulfill({
          status: 200, body: readFileSync(file), contentType: types[extname(file)] ?? 'application/octet-stream',
          headers: { 'content-security-policy': csp, 'x-content-type-options': 'nosniff' },
        })
      } catch {
        await route.fulfill({ status: 404 })
      }
    })
    await context.route(`${parentOrigin}/**`, async (route) => {
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe id="dsh" src="${remoteOrigin}/remote.html"></iframe><script>
        window.requests = 0;
        addEventListener('message', event => {
          if (event.origin !== '${remoteOrigin}' || event.data?.kind !== 'ready') return;
          const channel = new MessageChannel();
          channel.port1.onmessage = ({data}) => {
            if (data.t !== 'req' || !data.url.endsWith('/__boot__')) return;
            window.requests++;
            channel.port1.postMessage({t:'res', id:data.id, status:200,
              headers:{'content-type':'application/json'}, body:JSON.stringify({injections:[]})});
          };
          event.source.postMessage({schema:'dsh-remote-frame/v1',kind:'connect',nonce:event.data.nonce},
            '${remoteOrigin}',[channel.port2]);
        });
      </script>` })
    })
    const page = await context.newPage()
    await page.goto(parentOrigin)
    await expect.poll(() => page.evaluate(() => (window as unknown as { requests: number }).requests)).toBe(1)
    const child = page.frameLocator('#dsh')
    await expect.poll(() => child.locator('body').innerText()).toContain('window.__ModuleLoader__ bootstrap facade is missing')
    expect(await child.locator('body').evaluate(() => document.cookie)).toBe('')
    expect(await child.locator('body').evaluate(async () => {
      try { await fetch('https://example.com/'); return 'allowed' }
      catch { return 'blocked' }
    })).toBe('blocked')

    await context.route('https://attacker.example/**', async (route) => {
      await route.fulfill({ contentType: 'text/html', body:
        `<!doctype html><iframe id="dsh" src="${remoteOrigin}/remote.html"></iframe>` })
    })
    const attacker = await context.newPage()
    await attacker.goto('https://attacker.example')
    expect(attacker.frames().map(frame => frame.url())).toContain('chrome-error://chromewebdata/')
    await context.close()
  } finally {
    await browser?.close()
    rmSync(built, { recursive: true, force: true })
  }
}, 60_000)
