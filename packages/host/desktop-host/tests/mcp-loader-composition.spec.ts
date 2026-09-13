import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { boot, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { startHttpMcpFixture } from '../../../mcp/mcp-client/tests/http-fixture.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfileMcpExecutor } from '../src/profile-mcp-executor.ts'

it('loads the installed Hub MCP rows through the real Loader and calls the discovered MCP tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hmcp-load-')); const profileId = randomUUID()
  const web = join(root, 'profiles', 'web'); mkdirSync(web, { recursive: true, mode: 0o700 })
  const config = join(web, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    { id: 'prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  ]))
  const endpoint = await startHttpMcpFixture()
  const replacement = await startHttpMcpFixture()
  let ctx: Context | undefined
  const executor = new ProfileMcpExecutor({ profileRoot: (id) => { if (id !== profileId) throw Error('wrong Profile'); return root },
    uid: process.getuid!(), reload: async () => {
      await ctx?.fiber.dispose()
      ctx = await boot('host-mcp-test', config, loadOptionalPatches('host-mcp-test', join(web, 'cordis.patch.yml')),
        undefined, pathToFileURL(fileURLToPath(new URL('../../../../apps/cli/', import.meta.url))).href)
    } })
  const operations = new ProfileExtensionOperations(new FileExtensionReceipts(join(root, 'receipts'), process.getuid!()), executor, { now: () => 1000 })
  onTestFinished(async () => {
    await operations.dispose(); await ctx?.fiber.dispose(); await endpoint.close(); await replacement.close()
    rmSync(root, { recursive: true, force: true })
  })
  const plan = await operations.prepare(() => profileId, 'mcp', JSON.stringify({ mcpServers: { installed: { url: endpoint.url } } }))
  const id = randomUUID(); operations.commit(() => profileId, plan.planId, id); await operations.settled()
  expect(operations.status(() => profileId, id).state).toBe('succeeded')
  if (!ctx) throw Error('Profile did not start')
  expect(ctx.tools.get('mcp__installed__ping')).toBeDefined()
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('installed-ping'),
    name: 'mcp__installed__ping', arguments: {} })
  expect(result.isError).toBe(false)
  expect(result.content).toContainEqual({ type: 'text', text: 'pong' })
  const update = await operations.prepare(() => profileId, 'mcp', JSON.stringify({ action: 'update', id: 'mcp-installed',
    mcpServers: { installed: { url: replacement.url, headers: { Authorization: 'fixture-new' } } } }))
  const updateId = randomUUID(); operations.commit(() => profileId, update.planId, updateId); await operations.settled()
  expect(operations.status(() => profileId, updateId).state).toBe('succeeded')
  const oldRequests = endpoint.authorization.length
  const updatedResult = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('updated-ping'),
    name: 'mcp__installed__ping', arguments: {} })
  expect(updatedResult.isError).toBe(false)
  expect(replacement.authorization).toContain('fixture-new')
  expect(endpoint.authorization.length).toBe(oldRequests)
  const removal = await operations.prepare(() => profileId, 'mcp', JSON.stringify({ action: 'remove', id: 'mcp-installed' }))
  expect(ctx.tools.get('mcp__installed__ping')).toBeDefined()
  const removalId = randomUUID(); operations.commit(() => profileId, removal.planId, removalId); await operations.settled()
  expect(operations.status(() => profileId, removalId).state).toBe('succeeded')
  expect(ctx.tools.get('mcp__installed__ping')).toBeUndefined()
  expect(await executor.inventory(profileId)).toEqual([])
}, 20_000)
