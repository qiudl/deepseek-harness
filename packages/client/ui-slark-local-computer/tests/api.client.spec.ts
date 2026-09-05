import { describe, expect, it, vi } from 'vitest'
import {
  SelectionConflictError,
  listLocalComputerTargets,
  selectLocalComputerTarget,
} from '../src/client/api.ts'

const GRANT = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'

function state(extra: Record<string, unknown> = {}) {
  return {
    items: [{
      grant_id: GRANT,
      computer_label: 'Studio Mac',
      computer_display_code: 'MAC-4F2A',
      workspace_alias: 'Source',
      mode: 'read_write',
      expires_at: '2030-01-01T00:00:00.000Z',
    }],
    selected_grant_id: GRANT,
    publication_version: 4,
    selection_required: false,
    ...extra,
  }
}

describe('Slark local-computer API', () => {
  it('parses the bounded list and emits one explicit CAS selection', async () => {
    const fetchEdge = vi.fn()
      .mockResolvedValueOnce(Response.json(state()))
      .mockResolvedValueOnce(Response.json(state({ reload_required: true })))

    await expect(listLocalComputerTargets(fetchEdge)).resolves.toMatchObject({
      selectedGrantId: GRANT,
      publicationVersion: 4,
      items: [{ computerLabel: 'Studio Mac', workspaceAlias: 'Source' }],
    })
    await expect(selectLocalComputerTarget(fetchEdge, GRANT, 4)).resolves.toMatchObject({ reloadRequired: true })
    expect(fetchEdge.mock.calls[1]).toEqual([
      '/api/slark/v1/local-computer-target',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ grant_id: GRANT, expected_publication_version: 4 }),
      }),
    ])
  })

  it('rejects hostile responses and exposes only a typed CAS conflict', async () => {
    await expect(listLocalComputerTargets(vi.fn(async () => Response.json({ ...state(), leak: true }))))
      .rejects.toThrow('response_invalid')
    await expect(selectLocalComputerTarget(vi.fn(async () => Response.json({
      code: 'selection_conflict',
      selected_grant_id: GRANT,
      publication_version: 5,
    }, { status: 409 })), GRANT, 4)).rejects.toBeInstanceOf(SelectionConflictError)
    await expect(selectLocalComputerTarget(vi.fn(), 'not-a-grant', 4)).rejects.toThrow('request_invalid')
  })

  it.each([
    ['primitive envelope', 'bad'],
    ['null envelope', null],
    ['array envelope', []],
    ['missing field', { items: [], selected_grant_id: null, publication_version: 0 }],
    ['too many items', state({ items: Array.from({ length: 65 }, () => state().items[0]) })],
    ['selected id type', state({ selected_grant_id: 7 })],
    ['selected id syntax', state({ selected_grant_id: 'bad' })],
    ['publication fraction', state({ publication_version: 1.5 })],
    ['publication negative', state({ publication_version: -1 })],
    ['selection flag type', state({ selection_required: 'false' })],
    ['item primitive', state({ items: ['bad'], selected_grant_id: null })],
    ['item extra field', state({ items: [{ ...state().items[0], secret: true }] })],
    ['grant id type', state({ items: [{ ...state().items[0], grant_id: 7 }], selected_grant_id: null })],
    ['grant id syntax', state({ items: [{ ...state().items[0], grant_id: 'bad' }], selected_grant_id: null })],
    ['workspace type', state({ items: [{ ...state().items[0], workspace_alias: 7 }] })],
    ['workspace empty', state({ items: [{ ...state().items[0], workspace_alias: '' }] })],
    ['workspace too long', state({ items: [{ ...state().items[0], workspace_alias: 'x'.repeat(129) }] })],
    ['mode first mismatch', state({ items: [{ ...state().items[0], mode: 'execute' }] })],
    ['mode second mismatch', state({ items: [{ ...state().items[0], mode: 'read' }] })],
    ['expiry type', state({ items: [{ ...state().items[0], expires_at: 7 }] })],
    ['label empty', state({ items: [{ ...state().items[0], computer_label: '' }] })],
    ['display code too long', state({ items: [{ ...state().items[0], computer_display_code: 'x'.repeat(33) }] })],
    ['duplicate grants', state({ items: [state().items[0], state().items[0]] })],
    ['selected grant absent', state({ selected_grant_id: SECOND })],
  ])('rejects invalid target shape: %s', async (_name, body) => {
    await expect(listLocalComputerTargets(vi.fn(async () => Response.json(body))))
      .rejects.toThrow('response_invalid')
  })

  it('accepts nullable selection and omitted computer labels without synthesizing identifiers', async () => {
    const item = { ...state().items[0] }
    delete (item as Partial<typeof item>).computer_label
    delete (item as Partial<typeof item>).computer_display_code
    await expect(listLocalComputerTargets(vi.fn(async () => Response.json(state({
      items: [item], selected_grant_id: null, publication_version: 0, selection_required: true,
    }))))).resolves.toEqual({
      items: [{
        grantId: GRANT,
        workspaceAlias: 'Source',
        mode: 'read_write',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }],
      selectedGrantId: null,
      publicationVersion: 0,
      selectionRequired: true,
    })
  })

  it.each([
    ['wrong code', { code: 'grant_unavailable', selected_grant_id: null, publication_version: 5 }],
    ['selected id type', { code: 'selection_conflict', selected_grant_id: 7, publication_version: 5 }],
    ['selected id syntax', { code: 'selection_conflict', selected_grant_id: 'bad', publication_version: 5 }],
    ['publication type', { code: 'selection_conflict', selected_grant_id: null, publication_version: '5' }],
    ['publication negative', { code: 'selection_conflict', selected_grant_id: null, publication_version: -1 }],
    ['extra field', { code: 'selection_conflict', selected_grant_id: null, publication_version: 5, leak: true }],
  ])('rejects malformed conflict: %s', async (_name, body) => {
    await expect(selectLocalComputerTarget(
      vi.fn(async () => Response.json(body, { status: 409 })), GRANT, 4,
    )).rejects.toThrow('response_invalid')
  })

  it('enforces bounded JSON and propagates only generic request failures', async () => {
    await expect(listLocalComputerTargets(vi.fn(async () => new Response('{}', {
      headers: { 'content-length': 'many' },
    })))).rejects.toThrow('response_invalid')
    await expect(listLocalComputerTargets(vi.fn(async () => new Response('{}', {
      headers: { 'content-length': '65537' },
    })))).rejects.toThrow('response_invalid')
    await expect(listLocalComputerTargets(vi.fn(async () => new Response('{}', {
      headers: { 'content-length': '2' }, status: 500,
    })))).rejects.toThrow('request_failed')
    await expect(listLocalComputerTargets(vi.fn(async () => new Response('x'.repeat(65_537)))))
      .rejects.toThrow('response_invalid')
    await expect(listLocalComputerTargets(vi.fn(async () => new Response('{'))))
      .rejects.toThrow('response_invalid')
    await expect(selectLocalComputerTarget(vi.fn(async () => new Response('{}', { status: 503 })), GRANT, 4))
      .rejects.toThrow('request_failed')
  })

  it('rejects each invalid CAS input and a selection response without a boolean reload decision', async () => {
    await expect(selectLocalComputerTarget(vi.fn(), GRANT, 1.5)).rejects.toThrow('request_invalid')
    await expect(selectLocalComputerTarget(vi.fn(), GRANT, -1)).rejects.toThrow('request_invalid')
    await expect(selectLocalComputerTarget(
      vi.fn(async () => Response.json(state({ reload_required: 'yes' }))), GRANT, 0,
    )).rejects.toThrow('response_invalid')
  })
})
