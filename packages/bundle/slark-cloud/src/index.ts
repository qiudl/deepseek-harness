/** Slark cloud Runtime Cell ingress guard and bundle marker. */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name for direct diagnostic mounts. */
export const name = 'slark-cloud-bundle'
/** The Web transport must exist before its global guard is registered. */
export const inject = ['webServer']

const TOKEN = /^v1\.(\d{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u
const CLAIM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const TOKEN_TTL_SECONDS = 30

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function ingressKey(raw: string | undefined): Buffer {
  if (raw === undefined) throw new Error('slark-cloud: DSH_CELL_INGRESS_KEY is required')
  const decoded = Buffer.from(raw, 'base64url')
  if (decoded.length !== 32 || decoded.toString('base64url') !== raw) {
    throw new Error('slark-cloud: DSH_CELL_INGRESS_KEY must be canonical 32-byte base64url')
  }
  return decoded
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Canonical message signed by the Edge for one Cell request. */
export function cellIngressMessage(
  timestamp: string,
  nonce: string,
  method: string,
  url: string,
  environment: string,
  assignment: string,
  generation: string,
  subject: string,
): string {
  return ['v1', timestamp, nonce, method.toUpperCase(), url, environment, assignment, generation, subject].join('\n')
}

/** Validate a short-lived Edge-to-Cell request token. */
export function verifyCellIngressRequest(
  req: IncomingMessage,
  key: Buffer,
  now: () => number = Date.now,
): boolean {
  const token = header(req, 'x-slark-dsh-ingress-token')
  const match = token?.match(TOKEN)
  if (!match) return false
  const [, timestamp = '', nonce = '', signature = ''] = match
  const nowSeconds = Math.floor(now() / 1000)
  const tokenSeconds = Number(timestamp)
  if (!Number.isSafeInteger(tokenSeconds) || Math.abs(nowSeconds - tokenSeconds) > TOKEN_TTL_SECONDS) return false
  const environment = header(req, 'x-slark-dsh-environment') ?? ''
  const assignment = header(req, 'x-slark-dsh-assignment') ?? ''
  const generation = header(req, 'x-slark-dsh-generation') ?? ''
  const subject = header(req, 'x-slark-dsh-subject') ?? ''
  if (![environment, assignment, generation, subject].every(value => CLAIM.test(value))) return false
  const expected = createHmac('sha256', key)
    .update(cellIngressMessage(timestamp, nonce, req.method ?? '', req.url ?? '/', environment, assignment, generation, subject))
    .digest()
  const supplied = Buffer.from(signature, 'base64url')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/** Require Edge authentication on every non-loopback HTTP and WebSocket request. */
export function apply(ctx: Context): void {
  const key = ingressKey(process.env.DSH_CELL_INGRESS_KEY)
  ctx.effect(
    () => ctx.webServer.registerRequestGuard(req => isLoopback(req) || verifyCellIngressRequest(req, key)),
    'slark-cloud: Edge-to-Cell ingress guard',
  )
}
