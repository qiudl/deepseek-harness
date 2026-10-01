// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LocalSessionTakeover } from '../src/client/skeleton/LocalSessionTakeover.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Desktop local Session takeover', () => {
  it('asks for confirmation and submits the freshly observed Host epoch', async () => {
    const requests: Array<{ method: string; payload: { args: { expectedEpoch?: number } } }> = []
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as typeof requests[number]
      requests.push(request)
      return new Response(JSON.stringify({ result: { ok: true, value:
        request.method === 'session/localControlTakeover'
          ? { outcome: 'controlled', claim: { kind: 'local', epoch: 6 } }
          : { outcome: 'held_elsewhere', claim: { kind: 'remote', epoch: 5 } },
      } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const confirm = vi.fn(() => true)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('confirm', confirm)
    render(<LocalSessionTakeover {...({ sessionId: 'session-1', t: makeTranslate(zh) } as
      Parameters<typeof LocalSessionTakeover>[0])} />)
    const button = await screen.findByRole('button', { name: zh['control.remoteHeld'] })
    fireEvent.click(button)
    await waitFor(() => { expect(requests.length).toBe(3) })
    expect(confirm).toHaveBeenCalledWith(zh['control.confirmTakeover'])
    expect(requests[2]?.method).toBe('session/localControlTakeover')
    expect(requests[2]?.payload.args.expectedEpoch).toBe(5)
  })
})
