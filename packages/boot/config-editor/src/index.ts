/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service, resolveConfig } from '@deepseek-ai/cordis'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import { composeEntries, loadProfileDirectory, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'
import z from '@deepseek-ai/schemastery'
import {
  mergeOwnerSettings, ownerSettingsOverride, ownerSettingsSection, ownerSettingsValues,
  readOwnerSettings, replaceOwnerSettingsSection, updateOwnerSettingsValues,
} from './owner-settings.ts'

function settingsSchema(fiber: Entry['fiber']): z | undefined {
  const schema = fiber?.runtime?.Config
  return schema !== undefined && 'toJSON' in schema ? schema as z : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

/** Optional mutable settings authority supplied by an embedded Host. */
export interface Config {
  /** Absolute path to the owner-only settings file in the active migration generation. */
  ownerSettingsPath?: string
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/** Persist complete raw configs and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']
  static Config = z.object({ ownerSettingsPath: z.string() })
  private validatingEntry: Entry | undefined

  constructor(private readonly ownerContext: Context, private readonly options: Config = {}) {
    super(ownerContext, 'configEditor')
    if (options.ownerSettingsPath === undefined) return
    if (!isAbsolute(options.ownerSettingsPath)) {
      throw new Error('Owner settings path must be absolute')
    }
    readOwnerSettings(options.ownerSettingsPath)
    const path = options.ownerSettingsPath
    const validationTarget = (): Entry | undefined => this.validatingEntry
    ownerContext.on('internal/config', function (_raw, next) {
      const raw: unknown = next()
      if (this.entry === undefined || this.entry === validationTarget()
        || this.entry.parent.tree.ctx.fiber.entry?.id !== 'include') return raw
      const stored = ownerSettingsSection(readOwnerSettings(path).sections, this.entry.options.id)
      const section = ownerSettingsValues(settingsSchema(this), stored)
      return Object.keys(section).length === 0 ? raw : mergeOwnerSettings(raw, section)
    }, { global: true })
    // Bundle row order does not determine activation order. Consumers that started
    // before this service need the same owner overlay as subsequently loaded rows.
    for (const entry of this.entries()) {
      if (entry.fiber === undefined) continue
      const stored = ownerSettingsSection(readOwnerSettings(path).sections, entry.options.id)
      if (Object.keys(ownerSettingsValues(settingsSchema(entry.fiber), stored)).length === 0) continue
      if (entry.fiber.state === FiberState.ACTIVE) entry.fiber.update(entry.options.config, true)
      else {
        const stop = ownerContext.on('internal/status', (fiber) => {
          if (fiber !== entry.fiber || fiber.state !== FiberState.ACTIVE) return
          stop()
          fiber.update(entry.options.config, true)
        }, { global: true })
      }
    }
  }

  /** The profile patch, or the Host-owned mutable settings document when configured. */
  get documentPath(): string { return this.options.ownerSettingsPath ?? this.ownerContext.profileContext.patchPath }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Active entries with unique profile patch ids.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit profile values for the active entries.
   * @returns Detached layer values alongside their Loader entries.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const entries = this.entries()
    if (this.options.ownerSettingsPath !== undefined) {
      const { sections } = readOwnerSettings(this.options.ownerSettingsPath)
      const base = new Map(flatten(composeEntries([readProfilePatches('dsh', profile)])).map(row => [row.id, row.config]))
      return entries.map(entry => ({ entry,
        inherited: structuredClone((base.get(entry.options.id) ?? {}) as Record<string, unknown>),
        override: ownerSettingsValues(settingsSchema(entry.fiber), ownerSettingsSection(sections, entry.options.id)),
      }))
    }
    // An own config key can replace inherited config even when its value is undefined.
    const overridden = new Set(loaded.patches.filter(patch => patch.insert === undefined && Object.hasOwn(patch, 'config')).map(patch => patch.id))
    const composed = new Map<string, EntryOptions>()
    if (entries.some(entry => !overridden.has(entry.options.id))) {
      for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))) {
        if (!composed.has(row.id)) composed.set(row.id, row)
      }
    }
    return entries.map(entry => ({
      entry,
      inherited: overridden.has(entry.options.id)
        ? this.inherited(entry, loaded)
        : structuredClone((composed.get(entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((loaded.patches.findLast(
        row => row.id === entry.options.id && row.config !== undefined,
      )?.config ?? {}) as Record<string, unknown>),
    }))
  }

  private inherited(entry: Entry, loaded: ReturnType<typeof loadProfileDirectory>): Record<string, unknown> {
    const patches = loaded.patches.map((patch) => {
      if (patch.id !== entry.options.id || patch.insert !== undefined) return patch
      const rest = { ...patch }; Reflect.deleteProperty(rest, 'config')
      return rest
    })
    const row = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), patches])).find(row => row.id === entry.options.id)
    return structuredClone((row?.config ?? {}) as Record<string, unknown>)
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @returns Fulfillment after Loader reconciliation completes.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const path = this.documentPath
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        if (!this.entries().includes(entry) || entry.fiber === undefined) throw new Error('Configuration entry is no longer available')
        const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
        await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
        if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
        if (this.options.ownerSettingsPath !== undefined) {
          await this.editOwnerSettings(entry, change, beforePatches, this.options.ownerSettingsPath, entry.fiber)
          return
        }
        const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
        const inherited = this.inherited(entry, loadProfileDirectory('dsh', this.ownerContext.profileContext.dir, this.ownerContext.profileContext.installAnchor))
        const next = change(current, inherited)
        const fiber = entry.fiber
        if (fiber.state !== FiberState.ACTIVE) throw new Error('Configuration plugin is no longer active')
        const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
        resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
        let before: string
        try { before = await readFile(path, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          before = '[]\n'
        }
        const document = parseDocument(before, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        if (document.errors[0] !== undefined) throw document.errors[0]
        if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
        document.contents.flow = false
        const index = document.contents.items.findLastIndex((item, index) => isMap(item)
          && document.getIn([index, 'id']) === entry.options.id && !item.has('insert')
          && (!item.has('name') || document.getIn([index, 'name']) === entry.options.name))
        if (isDeepStrictEqual(next, inherited)) {
          for (let index = document.contents.items.length - 1; index >= 0; index--) {
            const row = document.contents.items[index]
            if (!isMap(row) || document.getIn([index, 'id']) !== entry.options.id || row.has('insert')) continue
            row.delete('config')
            if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) document.delete(index)
          }
        } else if (index < 0) document.add(document.createNode({ id: entry.options.id, name: entry.options.name, config: next }))
        else document.setIn([index, 'config'], document.createNode(next))
        visit(document, { Map(_key, node) {
          if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
          const expression = new Scalar(node.get('__jsExpr'))
          expression.tag = 'tag:yaml.org,2002:js'
          return expression
        } })
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const effective = flatten(composeEntries([patches])).find(row => row.id === entry.options.id)
        if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
          throw new Error(`Configuration for "${entry.options.id}" is overridden by a home patch or command-line overlay`)
        }
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', [entry.options.id])
        } catch (error) {
          await writeFileAtomic(path, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }

  private async editOwnerSettings(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
    beforePatches: PatchOptions[],
    path: string,
    fiber: NonNullable<Entry['fiber']>,
  ): Promise<void> {
    const before = readOwnerSettings(path)
    const base = flatten(composeEntries([beforePatches])).find(row => row.id === entry.options.id)
    const inherited = structuredClone((base?.config ?? {}) as Record<string, unknown>)
    const schema = settingsSchema(fiber)
    const previous = ownerSettingsSection(before.sections, entry.options.id)
    const current = mergeOwnerSettings(inherited, ownerSettingsValues(schema, previous)) as Record<string, unknown>
    const next = change(current, inherited)
    if (fiber.state !== FiberState.ACTIVE) throw new Error('Configuration plugin is no longer active')
    if (!isDeepStrictEqual(next, mergeOwnerSettings(inherited, ownerSettingsValues(schema, next)))) {
      throw new Error('Owner settings edits may change only volatile Config fields')
    }
    this.validatingEntry = entry
    try {
      const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
      resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
    } finally { this.validatingEntry = undefined }
    const values = updateOwnerSettingsValues(schema, previous, ownerSettingsOverride(inherited, next))
    const document = yaml.dump(replaceOwnerSettingsSection(before.sections, entry.options.id, values))
    await writeFileAtomic(path, document, { mode: 0o600 })
    try {
      // The raw Loader row can be unchanged while its external settings changed.
      // noSave keeps Cordis' update hook from persisting a second configuration authority.
      fiber.update(inherited, true)
      await fiber.await()
      await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh', [entry.options.id])
    } catch (error) {
      await writeFileAtomic(path, before.text, { mode: 0o600 })
      fiber.update(inherited, true)
      await fiber.await()
      await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh', [entry.options.id])
      throw error
    }
  }
}

export default ConfigEditor
