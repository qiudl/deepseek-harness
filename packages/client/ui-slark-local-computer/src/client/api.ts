/** Non-sensitive local-computer target returned by the Slark Edge browser API. */
export interface LocalComputerTarget {
  grantId: string
  computerLabel?: string
  displayCode?: string
  workspaceAlias: string
  mode: 'read_only' | 'read_write'
  expiresAt: string
}

/** Current target choices and the publication version used for selection CAS. */
export interface LocalComputerTargets {
  items: LocalComputerTarget[]
  selectedGrantId: string | null
  publicationVersion: number
  selectionRequired: boolean
}

/** Successful selection result, including whether the browser must reload the Runtime Cell. */
export interface LocalComputerSelection extends LocalComputerTargets {
  reloadRequired: boolean
}

type Row = Record<string, unknown>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Signals that another browser operation changed the target publication first. */
export class SelectionConflictError extends Error {
  constructor() {
    super('selection_conflict')
    this.name = 'SelectionConflictError'
  }
}

function parseConflict(value: unknown): void {
  const data = row(value)
  exact(data, ['code', 'selected_grant_id', 'publication_version'])
  if (
    data.code !== 'selection_conflict'
    || (data.selected_grant_id !== null && (typeof data.selected_grant_id !== 'string' || !UUID.test(data.selected_grant_id)))
    || !Number.isSafeInteger(data.publication_version)
    || (data.publication_version as number) < 0
  ) throw new Error('response_invalid')
}

function row(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('response_invalid')
  return value as Row
}

function exact(value: Row, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value)
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error('response_invalid')
  }
}

function nonEmpty(value: unknown, maximum = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function parseTargets(value: unknown, selection = false): LocalComputerTargets | LocalComputerSelection {
  const data = row(value)
  const required = ['items', 'selected_grant_id', 'publication_version', 'selection_required']
  if (selection) required.push('reload_required')
  exact(data, required)
  if (
    !Array.isArray(data.items)
    || data.items.length > 64
    || (data.selected_grant_id !== null && (typeof data.selected_grant_id !== 'string' || !UUID.test(data.selected_grant_id)))
    || !Number.isSafeInteger(data.publication_version)
    || (data.publication_version as number) < 0
    || typeof data.selection_required !== 'boolean'
    || (selection && typeof data.reload_required !== 'boolean')
  ) throw new Error('response_invalid')
  const items = data.items.map((candidate) => {
    const item = row(candidate)
    exact(item, ['grant_id', 'workspace_alias', 'mode', 'expires_at'], ['computer_label', 'computer_display_code'])
    if (
      typeof item.grant_id !== 'string'
      || !UUID.test(item.grant_id)
      || !nonEmpty(item.workspace_alias)
      || (item.mode !== 'read_only' && item.mode !== 'read_write')
      || !nonEmpty(item.expires_at, 64)
      || (item.computer_label !== undefined && !nonEmpty(item.computer_label))
      || (item.computer_display_code !== undefined && !nonEmpty(item.computer_display_code, 32))
    ) throw new Error('response_invalid')
    const mode: LocalComputerTarget['mode'] = item.mode
    return {
      grantId: item.grant_id,
      ...(item.computer_label === undefined ? {} : { computerLabel: item.computer_label }),
      ...(item.computer_display_code === undefined ? {} : { displayCode: item.computer_display_code }),
      workspaceAlias: item.workspace_alias,
      mode,
      expiresAt: item.expires_at,
    }
  })
  const grantIds = new Set(items.map(item => item.grantId))
  if (grantIds.size !== items.length || (data.selected_grant_id !== null && !grantIds.has(data.selected_grant_id))) {
    throw new Error('response_invalid')
  }
  const base: LocalComputerTargets = {
    items,
    selectedGrantId: data.selected_grant_id,
    publicationVersion: data.publication_version as number,
    selectionRequired: data.selection_required,
  }
  return selection ? { ...base, reloadRequired: data.reload_required as boolean } : base
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 65_536)) throw new Error('response_invalid')
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > 65_536) throw new Error('response_invalid')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('response_invalid')
  }
}

/**
 * Fetches the current local-computer target projection from the same-origin Edge API.
 * @param fetchEdge Same-origin, CSRF-aware Edge request function.
 * @returns Exact, byte-bounded target state.
 */
export async function listLocalComputerTargets(fetchEdge: FetchEdge): Promise<LocalComputerTargets> {
  const response = await fetchEdge('/api/slark/v1/local-computer-targets', { method: 'GET', cache: 'no-store' })
  if (!response.ok) throw new Error('request_failed')
  return parseTargets(await boundedJson(response))
}

/**
 * Selects one Grant with the caller's observed publication version.
 * @param fetchEdge Same-origin, CSRF-aware Edge request function.
 * @param grantId Grant UUID selected by the user.
 * @param publicationVersion Publication version shown with the selection dialog.
 * @returns Updated target state and the Edge-owned reload decision.
 */
export async function selectLocalComputerTarget(
  fetchEdge: FetchEdge,
  grantId: string,
  publicationVersion: number,
): Promise<LocalComputerSelection> {
  if (!UUID.test(grantId) || !Number.isSafeInteger(publicationVersion) || publicationVersion < 0) throw new Error('request_invalid')
  const response = await fetchEdge('/api/slark/v1/local-computer-target', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_id: grantId, expected_publication_version: publicationVersion }),
  })
  if (response.status === 409) {
    parseConflict(await boundedJson(response))
    throw new SelectionConflictError()
  }
  if (!response.ok) throw new Error('request_failed')
  return parseTargets(await boundedJson(response), true) as LocalComputerSelection
}

/** Request function restricted by the connection plugin to same-origin Slark Edge paths. */
export type FetchEdge = (path: string, init?: RequestInit) => Promise<Response>
