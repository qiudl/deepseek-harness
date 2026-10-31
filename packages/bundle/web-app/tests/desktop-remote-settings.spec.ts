import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
/** Real Profile configuration writes through the fixed personal Host command. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { bindDesktopRemoteGateway } from '../src/desktop-remote-gateway.ts'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { DesktopRemoteSessionExecutor } from '../src/desktop-remote-session.ts'

it('persists into the selected Profile, preserves optimistic conflicts and redacts secret settings', async () => {
  const { ctx, profile } = await configurationFixture()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(TypertGateway)
  await ctx.plugin(SettingsController)
  const executor = new DesktopRemoteSessionExecutor(bindDesktopRemoteGateway(ctx.typertGateway, new Peer(ctx.root, { principal: { kind: 'owner' } })))
  const describe = ctx.settingsController.describe()
  const model = describe.namespaces.find(row => row.ns === 'default-model')!
  const command = { operation: 'settings.apply' as const, command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
    request: { method: 'mutate' as const, args: { ns: 'default-model', expectedRevision: model.revision,
      ops: [{ op: 'set', path: ['model'], value: 'native-model' }] } } }
  const signal = new AbortController().signal
  const value = await executor.execute(command, signal)
  expect(value).toMatchObject({ ok: true, value: { value: { provider: 'test', model: 'native-model' } } })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('native-model')
  expect(await readFile(profile.patchPath, 'utf8')).toContain('native-model')
  expect(await executor.execute(command, signal)).toMatchObject({ ok: false, error: { code: 'settings/conflict' } })
  const first = ctx.settingsController.describe().namespaces.find(row => row.ns === 'first')!
  const redacted = await executor.execute({ ...command, request: { method: 'update', args: {
    ns: 'first', patch: { count: 3 }, expectedRevision: first.revision,
  } } }, signal)
  expect(redacted).toMatchObject({ ok: true, value: { value: { count: 3 } } })
  expect(JSON.stringify(redacted)).not.toContain('private')
})

it('sets and removes through the real credential provider with metadata-only results', async () => {
  const { ctx } = await configurationFixture()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(TypertGateway)
  await ctx.plugin(MemoryCredentials, {})
  await ctx.plugin(SettingsController)
  const executor = new DesktopRemoteSessionExecutor(bindDesktopRemoteGateway(ctx.typertGateway, new Peer(ctx.root, { principal: { kind: 'owner' } })))
  const command_id = '123e4567-e89b-42d3-a456-426614174000' as never
  const signal = new AbortController().signal
  await expect(executor.execute({ operation: 'credentials.apply', command_id,
    request: { method: 'set', args: { ref: 'TEST_API_KEY', value: 'synthetic-secret' } } }, signal)).resolves.toEqual({ ok: true })
  const configured = await ctx.credentialsController.describe(['TEST_API_KEY'])
  expect(configured.TEST_API_KEY).toMatchObject({ configured: true, writable: true })
  expect(JSON.stringify(configured)).not.toContain('synthetic-secret')
  await expect(executor.execute({ operation: 'credentials.apply', command_id,
    request: { method: 'unset', args: { ref: 'TEST_API_KEY' } } }, signal)).resolves.toEqual({ ok: true })
  expect(await ctx.credentialsController.describe(['TEST_API_KEY'])).toMatchObject({ TEST_API_KEY: { configured: false } })
})
