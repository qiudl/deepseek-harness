/** REQ-20261018-0001: exercise the shipped inline artifact in a real isolated frame. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = await mkdtemp(join(tmpdir(), 'dsh-native-built-'))
let browser
const failures = []
try {
  const document = await readFile(new URL('../dist-native/native.html', import.meta.url), 'utf8')
  assert.ok(document.length < 10 * 1024 * 1024)
  await writeFile(join(root, 'parent.html'), '<!doctype html><body></body>')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => failures.push(error.stack ?? error.message))
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()) })
  await page.goto(pathToFileURL(join(root, 'parent.html')).href)
  const response = await page.evaluate(async html => {
    const frame = document.createElement('iframe')
    frame.sandbox = 'allow-scripts'
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('native artifact did not boot')), 15000)
      const onMessage = event => {
        if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.kind !== 'ready') return
        window.removeEventListener('message', onMessage)
        const channel = new MessageChannel()
        channel.port1.onmessage = message => {
          clearTimeout(timer)
          channel.port1.close()
          resolve({ origin: event.origin, request: message.data })
        }
        frame.contentWindow.postMessage({ schema: 'dsh-remote-frame/v1', kind: 'connect', nonce: event.data.nonce,
          assetOrigin: 'https://ui.example.test' }, '*', [channel.port2])
      }
      window.addEventListener('message', onMessage)
      frame.srcdoc = html
      document.body.append(frame)
    })
  }, document)
  assert.equal(response.origin, 'null')
  assert.equal(response.request.t, 'req')
  assert.equal(response.request.url, 'https://ui.example.test/__boot__')
  const frame = page.frames().find(item => item !== page.mainFrame())
  assert.ok(frame)
  const context = await frame.evaluate(() => {
    let isolated = false
    try { parent.document.body } catch { isolated = true }
    localStorage.setItem('draft-probe', 'temporary')
    return { isolated, secure: isSecureContext, crypto: !!crypto.subtle, value: localStorage.getItem('draft-probe') }
  })
  assert.deepEqual(context, { isolated: true, secure: true, crypto: true, value: 'temporary' })
  assert.deepEqual(failures, [])
  console.log('native artifact: isolated origin, CSP execution, crypto, volatile storage and Host namespace PASS')
} catch (error) {
  console.error(failures)
  throw error
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
