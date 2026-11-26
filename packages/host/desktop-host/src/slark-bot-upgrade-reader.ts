import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BundledPlugin, BundledPluginCatalog } from './bundled-plugins.ts'
import { verifyCopiedBundledPlugin } from './bundled-plugin-recovery.ts'
import { capturePluginTree, materializePrivateTreeSnapshot } from './plugin-tree-snapshot.ts'
import type { BotUpgradeGeneration, BotUpgradeGenerations } from './bot-upgrade-generation.ts'

interface StoreRuntime extends Record<string, unknown> {
  home: string
  statePath: string
  warn(): void
  ctx: { effect(setup: () => unknown): void }
  autoRoomName(members: readonly string[]): string
  retitleRoom(): Promise<void>
  keepGroupLine(roomId: string, line: unknown, text: string): unknown
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function method(runtime: Record<string, unknown>, name: string): (...args: unknown[]) => unknown {
  const value = runtime[name]
  if (typeof value !== 'function') throw new ProfileUpgradeFailure('bot_upgrade_reader_incompatible')
  return (...args) => { const result: unknown = Reflect.apply(value, runtime, args); return result }
}

/**
 * Run only the verified package's store in an unpublished copy, without providers, tools or background work.
 * This adapter accepts additive normalization only; conversions involving history spill or Session retitles
 * are refused until their schema owners participate in a separately tested migration.
 * @param options Exact catalog target, operation-owned copies and live maintenance authorization.
 * @returns Nothing after the precise target reader and byte/semantic preservation checks succeed.
 */
export async function verifyBundledBotStoreCopy(options: {
  readonly profileRoot: string
  readonly controlRoot: string
  readonly uid: number
  readonly catalog: BundledPluginCatalog
  readonly plugin: BundledPlugin
  readonly generation: BotUpgradeGeneration
  readonly generations: BotUpgradeGenerations
  readonly guard: () => void
}): Promise<void> {
  const { guard, plugin, catalog, uid, generation } = options
  guard()
  if (plugin.name !== 'ds-bot') throw new ProfileUpgradeFailure('bot_upgrade_reader_incompatible')
  const web = join(options.profileRoot, 'profiles/web')
  await verifyCopiedBundledPlugin(catalog, plugin, web, uid)
  guard()
  const snapshot = capturePluginTree(join(web, 'node_modules', plugin.name), uid)
  await verifyCopiedBundledPlugin(catalog, plugin, web, uid)
  guard()
  // Every operation gets a new module URL and dependency closure. Importing an updated
  // installed path would reuse Node's cached relative imports from an older package.
  const reader = join(options.controlRoot, 'reader')
  if (!existsSync(reader)) materializePrivateTreeSnapshot(reader, snapshot.bytes, snapshot.digest, uid, guard)
  else if (capturePluginTree(reader, uid).digest !== snapshot.digest) throw new ProfileUpgradeFailure('bot_upgrade_reader_changed')
  const store = await import(pathToFileURL(join(reader, 'src/host/store.js')).href) as Readonly<Record<string, unknown>>
  const constants = await import(pathToFileURL(join(reader, 'src/host/constants.js')).href) as Readonly<Record<string, unknown>>
  guard()
  if (typeof store.install !== 'function'
    || !Number.isSafeInteger(constants.TEXT_KEPT) || Number(constants.TEXT_KEPT) < 1) throw new ProfileUpgradeFailure('bot_upgrade_reader_incompatible')
  const textKept = Number(constants.TEXT_KEPT)
  const cleanup: Array<() => Promise<unknown>> = []
  const observation = { needsSessionRetitle: false }
  const runtime: StoreRuntime = {
    home: generation.candidateHome, statePath: join(generation.candidateHome, 'state.json'), warn() {},
    ctx: { effect(setup) {
      const dispose = setup()
      if (dispose !== undefined && typeof dispose !== 'function') throw new ProfileUpgradeFailure('bot_upgrade_reader_incompatible')
      if (typeof dispose === 'function') cleanup.push(() => Promise.resolve().then(() => {
        const result: unknown = Reflect.apply(dispose, undefined, [])
        return result
      }))
    } },
    autoRoomName(members) {
      const state = runtime.state, bots = object(state) && object(state.bots) ? state.bots : {}
      return ['You', ...members.map(id => object(bots[id]) ? bots[id].name : undefined).filter(Boolean)].join(', ')
    },
    retitleRoom() { observation.needsSessionRetitle = true; return Promise.resolve() },
    keepGroupLine(_roomId, line, text) {
      if (text.length > textKept) throw new ProfileUpgradeFailure('bot_upgrade_history_conversion_required')
      return line
    },
  }
  try {
    Reflect.apply(store.install, undefined, [runtime])
    await method(runtime, 'load')()
    guard()
    if (method(runtime, 'hasExclusiveWriter')() !== true || method(runtime, 'readOnly')() !== undefined) {
      throw new ProfileUpgradeFailure('bot_upgrade_reader_not_writable')
    }
    await method(runtime, 'save')(true)
    guard()
    if (observation.needsSessionRetitle) throw new ProfileUpgradeFailure('bot_upgrade_session_conversion_required')
  } finally {
    // Await every owner disposer even if another one fails; no lock or writer may outlive the probe.
    const results = await Promise.allSettled(cleanup.reverse().map(dispose => dispose()))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw new ProfileUpgradeFailure('bot_upgrade_reader_shutdown_failed')
  }
  guard()
  options.generations.verifyCandidate(generation.operationId)
  if (capturePluginTree(reader, uid).digest !== snapshot.digest) throw new ProfileUpgradeFailure('bot_upgrade_reader_changed')
  await verifyCopiedBundledPlugin(catalog, plugin, web, uid)
  guard()
}
