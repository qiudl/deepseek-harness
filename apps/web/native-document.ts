import { createHash } from 'node:crypto'

/** Inline the shared Web build without interpreting replacement tokens inside compiled code.
 * @param page Vite-generated native page.
 * @param readAsset Read one generated asset relative to the output directory.
 * @returns Self-contained document with a hash-bound script policy and no network authority.
 */
export async function inlineNativePage(page: string, readAsset: (path: string) => Promise<string>): Promise<string> {
  const scripts = [...page.matchAll(/<script\b[^>]*src="\.\/([^"<>]+)"[^>]*><\/script>/gu)]
  if (scripts.length !== 1) throw Error('native document requires one bundled entry')
  const read = async (path: string): Promise<string> => {
    if (!/^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/u.test(path)) throw Error('native asset path invalid')
    return await readAsset(path)
  }
  const script = scripts[0]!
  const js = (await read(script[1]!)).replace(/<\/script/giu, '<\\/script')
  let html = page.replace(script[0], () => `<script type="module">${js}</script>`)
  for (const style of [...page.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\.\/([^"<>]+)"[^>]*>/gu)]) {
    const css = (await read(style[1]!)).replace(/<\/style/giu, '<\\/style')
    html = html.replace(style[0], () => `<style>${css}</style>`)
  }
  const digest = createHash('sha256').update(js).digest('base64')
  const csp = `default-src 'none'; script-src 'sha256-${digest}' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  return html.replace('<head>', () => `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
}
