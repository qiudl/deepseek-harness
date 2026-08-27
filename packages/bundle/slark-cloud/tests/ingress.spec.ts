import { createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { cellIngressMessage, verifyCellIngressRequest } from '../src/index.ts'

const NOW = 1_800_000_000_000
const KEY = Buffer.alloc(32, 7)

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const timestamp = String(Math.floor(NOW / 1000))
  const nonce = Buffer.alloc(16, 3).toString('base64url')
  const headers = {
    'x-slark-dsh-environment': 'staging-cohost',
    'x-slark-dsh-assignment': 'assignment-1',
    'x-slark-dsh-generation': '3',
    'x-slark-dsh-subject': 'subject-1',
  }
  const signature = createHmac('sha256', KEY)
    .update(cellIngressMessage(
      timestamp,
      nonce,
      'POST',
      '/api/goals/create',
      headers['x-slark-dsh-environment'],
      headers['x-slark-dsh-assignment'],
      headers['x-slark-dsh-generation'],
      headers['x-slark-dsh-subject'],
    ))
    .digest('base64url')
  return {
    method: 'POST',
    url: '/api/goals/create',
    headers: {
      ...headers,
      'x-slark-dsh-ingress-token': `v1.${timestamp}.${nonce}.${signature}`,
    },
    ...overrides,
  } as IncomingMessage
}

describe('Cell ingress token', () => {
  it('accepts the exact request and rejects tampering or expiry', () => {
    expect(verifyCellIngressRequest(request(), KEY, () => NOW)).toBe(true)
    expect(verifyCellIngressRequest(request({ url: '/api/session.list' }), KEY, () => NOW)).toBe(false)
    expect(verifyCellIngressRequest(request(), KEY, () => NOW + 31_000)).toBe(false)
    expect(verifyCellIngressRequest(request(), Buffer.alloc(32, 8), () => NOW)).toBe(false)
  })
})
