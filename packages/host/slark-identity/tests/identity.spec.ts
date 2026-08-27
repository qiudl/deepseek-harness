import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SlarkDeviceAuthority } from '@deepseek-ai/dsh-slark-device-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SlarkIdentity from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }))
})

async function authorityFile(overrides: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-slark-identity-'))
  roots.push(root)
  const filename = join(root, 'authority.json')
  await writeFile(filename, JSON.stringify({
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
    grant_id: '22222222-2222-4222-8222-222222222222',
    grant_epoch: 7,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }))
  await chmod(filename, 0o600)
  return filename
}

async function setup(filename: string) {
  let source: (() => Promise<SlarkDeviceAuthority>) | undefined
  const disposeAuthority = vi.fn()
  const bindAuthority = vi.fn((next: () => Promise<SlarkDeviceAuthority>) => {
    source = next
    return disposeAuthority
  })
  const ctx = new Context()
  ctx.provide('slarkDevice', { bindAuthority })
  await ctx.plugin(SlarkIdentity, {
    authorityFile: filename,
    expectedWorkspaceHandle: 'workspace-1',
  })
  return {
    ctx,
    identity: ctx.slarkIdentity,
    source: () => {
      if (source === undefined) throw new Error('authority source was not bound')
      return source()
    },
    bindAuthority,
    disposeAuthority,
  }
}

describe('SlarkIdentity', () => {
  it('derives the calling DSH session while preserving the injected Grant fences', async () => {
    const harness = await setup(await authorityFile())

    const authority = await harness.identity.runForSession('session-1', harness.source)

    expect(authority).toEqual({
      subjectToken: 'subject-token',
      sessionId: 'session-1',
      computerId: 'computer-1',
      workspaceHandle: 'workspace-1',
      grantId: '22222222-2222-4222-8222-222222222222',
      grantEpoch: 7,
    })
    expect(harness.bindAuthority).toHaveBeenCalledTimes(1)
    await expect(harness.source()).rejects.toMatchObject({ code: 'identity_unavailable' })
    await harness.ctx.fiber.dispose()
    expect(harness.disposeAuthority).toHaveBeenCalledTimes(1)
  })

  it('keeps concurrent session contexts independent', async () => {
    const harness = await setup(await authorityFile())
    const [left, right] = await Promise.all([
      harness.identity.runForSession('session-left', async () => {
        await Promise.resolve()
        return harness.source()
      }),
      harness.identity.runForSession('session-right', async () => {
        await Promise.resolve()
        return harness.source()
      }),
    ])

    expect(left.sessionId).toBe('session-left')
    expect(right.sessionId).toBe('session-right')
    await harness.ctx.fiber.dispose()
  })

  it('re-reads an atomically replaceable authority snapshot for every operation', async () => {
    const filename = await authorityFile()
    const harness = await setup(filename)

    const first = await harness.identity.runForSession('session-1', harness.source)
    await writeFile(filename, JSON.stringify({
      protocol_version: 1,
      kind: 'slark-dsh-runtime-authority-v1',
      environment_id: 'staging',
      assignment_id: '11111111-1111-4111-8111-111111111111',
      generation: 4,
      owner_user_id: 'user-1',
      personal_project_id: 'project-1',
      subject_token: 'rotated-subject-token',
      computer_id: 'computer-1',
      workspace_handle: 'workspace-1',
      grant_id: '22222222-2222-4222-8222-222222222222',
      grant_epoch: 8,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), { mode: 0o600 })
    const second = await harness.identity.runForSession('session-1', harness.source)

    expect(first.subjectToken).toBe('subject-token')
    expect(second).toMatchObject({ subjectToken: 'rotated-subject-token', grantEpoch: 8 })
    await harness.ctx.fiber.dispose()
  })

  it('rejects expired, rebound, and non-private authority files', async () => {
    const expired = await setup(await authorityFile({ expires_at: new Date(Date.now() - 1).toISOString() }))
    await expect(expired.identity.runForSession('session-1', expired.source))
      .rejects.toMatchObject({ code: 'identity_expired' })
    await expired.ctx.fiber.dispose()

    const rebound = await setup(await authorityFile({ workspace_handle: 'workspace-2' }))
    await expect(rebound.identity.runForSession('session-1', rebound.source))
      .rejects.toMatchObject({ code: 'workspace_changed' })
    await rebound.ctx.fiber.dispose()

    const publicFile = await authorityFile()
    await chmod(publicFile, 0o644)
    const exposed = await setup(publicFile)
    await expect(exposed.identity.runForSession('session-1', exposed.source))
      .rejects.toMatchObject({ code: 'identity_unavailable' })
    await exposed.ctx.fiber.dispose()
  })

  it('refuses a symlink instead of following it to a credential', async () => {
    const target = await authorityFile()
    const root = await mkdtemp(join(tmpdir(), 'dsh-slark-identity-link-'))
    roots.push(root)
    const link = join(root, 'authority.json')
    await symlink(target, link)
    const harness = await setup(link)

    await expect(harness.identity.runForSession('session-1', harness.source))
      .rejects.toMatchObject({ code: 'identity_unavailable' })
    await harness.ctx.fiber.dispose()
  })
})
