/** Slark Edge double-submit names shared by the served browser transport. */
const COOKIE_NAME = '__Host-dsh_csrf'
const HEADER_NAME = 'x-slark-dsh-csrf'

/**
 * Mirror the Slark Edge CSRF cookie onto a default browser POST request.
 * @param init - request options passed to the page's fetch implementation.
 * @returns the original options outside Slark sessions, otherwise options with the authoritative cookie value.
 */
export function withSlarkCsrfHeader(init?: RequestInit): RequestInit | undefined {
  if (init?.method?.toUpperCase() !== 'POST') return init
  const prefix = `${COOKIE_NAME}=`
  const token = (globalThis as { document?: { cookie: string } }).document?.cookie
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix))
    ?.slice(prefix.length)
  if (!token) return init
  const headers = new Headers(init.headers)
  headers.set(HEADER_NAME, token)
  return { ...init, headers }
}
