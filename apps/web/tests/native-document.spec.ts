import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { inlineNativePage } from '../native-document.ts'

it('preserves compiled replacement tokens and binds the exact script with CSP', async () => {
  const page = '<html><head><script type="module" src="./assets/native.js"></script><link rel="stylesheet" href="./assets/style.css"></head><body></body></html>'
  const js = 'const literal = "$& $` $\' </script>";'
  const css = '.example::before{content:"$&"}'
  const result = await inlineNativePage(page, async path => path.endsWith('.js') ? js : css)
  const safe = js.replace('</script>', '<\\/script>')
  expect(result).toContain(`<script type="module">${safe}</script>`)
  expect(result).toContain(`<style>${css}</style>`)
  expect(result).toContain(`'sha256-${createHash('sha256').update(safe).digest('base64')}'`)
  expect(result).toContain("connect-src 'none'")
  expect(result).not.toContain('src="./assets/')
})
it('refuses missing, repeated and escaping entry assets', async () => {
  const script = '<script src="./assets/../private.js"></script>'
  for (const page of ['', script, script + script]) {
    await expect(inlineNativePage(page, async () => 'code')).rejects.toThrow()
  }
})
