import { createHash, createHmac } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SlarkDeviceAuthority } from '@deepseek-ai/dsh-slark-device-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SlarkIdentity, { cellRefreshMessage } from '../src/index.ts'

const roots: string[] = []
const refreshKey = Buffer.alloc(32, 8)

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(async (root) => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }))
})

function document(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: 1,
    kind: 'slark-dsh-runtime-authority-v1',
    environment_id: 'staging',
    assignment_id: '11111111-1111-4111-8111-111111111111',
    generation: 3,
    owner_user_id: 'user-1',
    personal_project_id: 'project-1',
    subject_token: 'subject-token',
    computer_id: 'computer-1',
    workspace_handle: 'workspace-1',
    workspace_alias: 'My Mac',
    grant_id: '22222222-2222-4222-8222-222222222222',
    grant_epoch: 7,
    expires_at: new Date(Date.now() + 180_000).toISOString(),
    ...overrides,
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-slark-identity-'))
  roots.push(root)
  const authorityDirectory = join(root, 'authority')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(authorityDirectory, { mode: 0o700 })
  await mkdir(workspaceRoot, { mode: 0o700 })
  await mkdir(join(workspaceRoot, 'workspace-1'), { mode: 0o700 })
  await writeFile(join(authorityDirectory, '.publication-state'), JSON.stringify({
    assignment_id: '11111111-1111-4111-8111-111111111111',
    generation: 3,
    publication_version: 1,
    workspace_handle: 'workspace-1',
    workspace_alias: 'My Mac',
    grant_id: '22222222-2222-4222-8222-222222222222',
    grant_epoch: 7,
  }), { mode: 0o600 })
  return { root, authorityDirectory, workspaceRoot }
}

async function writeAuthority(
  authorityDirectory: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  const filename = join(authorityDirectory, `${sessionId}.json`)
  await writeFile(filename, JSON.stringify(document(overrides)), { mode: 0o600 })
  return filename
}

async function setup(input: {
  authorityDirectory: string
  workspaceRoot: string
  expectedWorkspaceHandle?: string
  callerProfile?: 'web_dsh_v1'
  existingWorkspaces?: Array<{ id: string; path: string; title: string; setTitle: ReturnType<typeof vi.fn> }>
}) {
  let source: (() => Promise<SlarkDeviceAuthority>) | undefined
  const disposeAuthority = vi.fn()
  const bindAuthority = vi.fn((next: () => Promise<SlarkDeviceAuthority>) => {
    source = next
    return disposeAuthority
  })
  const workspaces = input.existingWorkspaces ?? []
  const create = vi.fn(async (path: string, title?: string) => {
    const existing = workspaces.find(workspace => workspace.path === path)
    if (existing) return existing
    const workspace = {
      id: `workspace-id-${workspaces.length + 1}`,
      path,
      title: title ?? '',
      setTitle: vi.fn(),
    }
    workspaces.push(workspace)
    return workspace
  })
  const remove = vi.fn(async (id: string) => {
    const index = workspaces.findIndex(workspace => workspace.id === id)
    if (index < 0) return false
    workspaces.splice(index, 1)
    return true
  })
  const ctx = new Context()
  ctx.provide('slarkDevice', { bindAuthority })
  ctx.provide('workspaceRegistry', { list: () => workspaces, create, delete: remove })
  await ctx.plugin(SlarkIdentity, {
    ...(input.callerProfile === undefined ? {} : { callerProfile: input.callerProfile }),
    authorityDirectory: input.authorityDirectory,
    workspaceRoot: input.workspaceRoot,
    expectedWorkspaceHandle: input.expectedWorkspaceHandle ?? 'workspace-1',
    environmentId: 'staging',
    cellId: '1',
    refreshUrl: 'http://127.0.0.1:4181/api/internal/v1/dsh/authority/refresh',
    refreshKey: refreshKey.toString('base64url'),
    refreshBeforeExpiryMs: 60_000,
  })
  return {
    ctx,
    identity: ctx.slarkIdentity,
    source: () => {
      if (source === undefined) throw new Error('authority source was not bound')
      return source()
    },
    disposeAuthority,
    workspaces,
    create,
    remove,
  }
}

describe('SlarkIdentity', () => {
  it('keeps concurrent DSH sessions on separate authority files', async () => {
    const state = await fixture()
    await writeAuthority(state.authorityDirectory, 'session-left', { subject_token: 'left-token' })
    await writeAuthority(state.authorityDirectory, 'session-right', { subject_token: 'right-token' })
    const harness = await setup(state)

    const [left, right] = await Promise.all([
      harness.identity.runForSession('session-left', harness.source),
      harness.identity.runForSession('session-right', harness.source),
    ])

    expect(left).toMatchObject({ sessionId: 'session-left', subjectToken: 'left-token' })
    expect(right).toMatchObject({ sessionId: 'session-right', subjectToken: 'right-token' })
    await harness.ctx.fiber.dispose()
    expect(harness.disposeAuthority).toHaveBeenCalledTimes(1)
  })

  it('single-flights a missing session refresh and verifies its body-bound Cell HMAC', async () => {
    const state = await fixture()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      if (typeof init?.body !== 'string') throw new Error('expected string refresh body')
      const body = init.body
      const parsed = JSON.parse(body) as { cell_id: string; session_id: string }
      const requestUrl = input instanceof Request ? input.url : input.toString()
      expect(requestUrl).toBe('http://127.0.0.1:4181/api/internal/v1/dsh/authority/refresh')
      expect(parsed).toEqual({ cell_id: '1', session_id: 'session-new' })
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      const match = authorization.match(/^DSH-Cell v1\.(\d{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/)
      expect(match).not.toBeNull()
      if (match === null) throw new Error('expected authenticated refresh')
      const [, timestamp = '', nonce = '', signature = ''] = match
      const expected = createHmac('sha256', refreshKey)
        .update(cellRefreshMessage(
          timestamp,
          nonce,
          'POST',
          '/api/internal/v1/dsh/authority/refresh',
          createHash('sha256').update(body).digest('hex'),
          'staging',
          '1',
        ))
        .digest('base64url')
      expect(signature).toBe(expected)
      await writeAuthority(state.authorityDirectory, 'session-new', { subject_token: 'fresh-token' })
      return Response.json({
        ok: true,
        workspace_handle: 'workspace-1',
        workspace_alias: 'My Mac',
        expires_at: document().expires_at,
      })
    }))
    const harness = await setup(state)

    const [first, second] = await Promise.all([
      harness.identity.authorityForSession('session-new'),
      harness.identity.authorityForSession('session-new'),
    ])

    expect(first.subjectToken).toBe('fresh-token')
    expect(second.subjectToken).toBe('fresh-token')
    expect(calls).toBe(1)
    await harness.ctx.fiber.dispose()
  })

  it('re-reads a session authority snapshot for every operation', async () => {
    const state = await fixture()
    await writeAuthority(state.authorityDirectory, 'session-1')
    const harness = await setup(state)

    const first = await harness.identity.runForSession('session-1', harness.source)
    await writeAuthority(state.authorityDirectory, 'session-1', {
      subject_token: 'rotated-subject-token',
      grant_epoch: 8,
    })
    const second = await harness.identity.runForSession('session-1', harness.source)

    expect(first.subjectToken).toBe('subject-token')
    expect(second).toMatchObject({ subjectToken: 'rotated-subject-token', grantEpoch: 8 })
    await harness.ctx.fiber.dispose()
  })

  it('parses the Web v2 fence set and rejects a stale selection publication', async () => {
    const state = await fixture()
    await writeAuthority(state.authorityDirectory, 'session-web', {
      protocol_version: 2,
      kind: 'slark-dsh-runtime-authority-v2',
      caller_profile: 'web_dsh_v1',
      authority_version: 9,
      consent_profile_version: 1,
      protected_root_policy_version: 1,
      safe_file_broker_protocol_version: 1,
      selection_publication_version: 1,
    })
    const harness = await setup({ ...state, callerProfile: 'web_dsh_v1' })

    await expect(harness.identity.authorityForSession('session-web')).resolves.toMatchObject({
      callerProfile: 'web_dsh_v1',
      authorityVersion: 9,
      assignmentGeneration: 3,
      selectionPublicationVersion: 1,
    })
    await writeAuthority(state.authorityDirectory, 'session-web', {
      protocol_version: 2,
      kind: 'slark-dsh-runtime-authority-v2',
      caller_profile: 'web_dsh_v1',
      authority_version: 10,
      consent_profile_version: 1,
      protected_root_policy_version: 1,
      safe_file_broker_protocol_version: 1,
      selection_publication_version: 2,
    })
    await expect(harness.identity.authorityForSession('session-web'))
      .rejects.toMatchObject({ code: 'identity_invalid' })
    await harness.ctx.fiber.dispose()
  })

  it('registers only the current managed workspace and applies its Slark alias', async () => {
    const state = await fixture()
    const stalePath = join(state.workspaceRoot, 'workspace-old')
    await mkdir(stalePath)
    const stale = { id: 'stale-id', path: await realpath(stalePath), title: 'Old', setTitle: vi.fn() }
    const harness = await setup({ ...state, existingWorkspaces: [stale] })

    expect(harness.remove).toHaveBeenCalledWith('stale-id')
    expect(harness.create).toHaveBeenCalledWith(
      join(await realpath(state.workspaceRoot), 'workspace-1'),
      'My Mac',
    )
    expect(harness.workspaces.map(workspace => workspace.title)).toEqual(['My Mac'])
    await harness.ctx.fiber.dispose()
  })

  it('rejects rebound, non-private, and symlinked session authority files', async () => {
    const state = await fixture()
    await writeAuthority(state.authorityDirectory, 'session-rebound', {
      workspace_handle: 'workspace-2',
    })
    const harness = await setup(state)
    await expect(harness.identity.authorityForSession('session-rebound'))
      .rejects.toMatchObject({ code: 'workspace_changed' })

    const publicFile = await writeAuthority(state.authorityDirectory, 'session-public')
    await chmod(publicFile, 0o666)
    await expect(harness.identity.authorityForSession('session-public'))
      .rejects.toMatchObject({ code: 'identity_unavailable' })

    const target = await writeAuthority(state.authorityDirectory, 'session-target')
    const link = join(state.authorityDirectory, 'session-link.json')
    await symlink(target, link)
    await expect(harness.identity.authorityForSession('session-link'))
      .rejects.toMatchObject({ code: 'identity_unavailable' })
    await harness.ctx.fiber.dispose()
  })
})
