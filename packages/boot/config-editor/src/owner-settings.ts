/** Released settings documents retained as the Host generation's mutable settings owner. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { isDeepStrictEqual } from 'node:util'
import type z from '@deepseek-ai/schemastery'

const aliases: Record<string, string> = {
  'ui-developer-tools': 'ui-settings',
  'ui-onboarding': 'ui-settings-general',
  /* v8 ignore next -- released bundles compose one shell executor per platform */
  shell: process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox',
}

function object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasLiveFields(schema: z): boolean {
  return schema.meta.volatile === true
    || schema.type === 'object' && Object.values(schema.dict ?? {}).some(hasLiveFields)
}

function settingsFields(schema: z | undefined, value: unknown, retained: unknown): unknown {
  if (schema === undefined || !hasLiveFields(schema)) return structuredClone(retained)
  if (schema.meta.volatile) return structuredClone(value)
  const result = object(retained) ? structuredClone(retained) : {}
  const input = object(value) ? value : {}
  // A non-volatile schema with live descendants is an object with a field dictionary.
  for (const [key, child] of Object.entries(schema.dict as Record<string, z>)) {
    const field = settingsFields(child, input[key], result[key])
    if (field === undefined) Reflect.deleteProperty(result, key)
    else Object.defineProperty(result, key, { value: field, enumerable: true, configurable: true, writable: true })
  }
  return result
}

/** Apply only live Config fields; settings documents cannot redirect Host-owned storage or credentials.
 * @param schema Plugin Config schema, if it has one.
 * @param section Released settings section.
 * @returns Live fields accepted by the current schema.
 */
export function ownerSettingsValues(schema: z | undefined, section: Record<string, unknown>): Record<string, unknown> {
  return settingsFields(schema, section, {}) as Record<string, unknown>
}

/** Replace live fields while retaining ordinary and unavailable fields in the migration document.
 * @param schema Current plugin Config schema.
 * @param previous Full released section.
 * @param next Sparse live-field override after editing.
 * @returns Updated section without discarding unrecognized stored values.
 */
export function updateOwnerSettingsValues(
  schema: z | undefined, previous: Record<string, unknown>, next: Record<string, unknown>,
): Record<string, unknown> {
  return settingsFields(schema, next, previous) as Record<string, unknown>
}

/** Read the Host's mutable settings generation without following links or accepting shared files.
 * @param path Absolute path supplied by the Host.
 * @returns Original bytes and parsed sections; unsafe or malformed documents throw.
 */
export function readOwnerSettings(path: string): { text: string; sections: Record<string, unknown> } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1
      || (before.mode & 0o077) !== 0 || before.size > 16 * 1024 * 1024) {
      throw new Error('Unsafe owner settings document')
    }
    const text = readFileSync(fd, 'utf8')
    const after = fstatSync(fd)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Owner settings changed during reading')
    }
    const parsed = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
    if (parsed.errors.length) throw new Error('Invalid owner settings document')
    const sections: unknown = parsed.toJS() ?? {}
    if (!object(sections) || Object.values(sections).some(section => !object(section))) {
      throw new Error('Owner settings must contain object sections')
    }
    return { text, sections }
  } finally { closeSync(fd) }
}

/** Preserve sparse legacy objects; arrays and scalar values replace their inherited value.
 * @param base Values from lower configuration layers.
 * @param override Values from the mutable settings document.
 * @returns Detached merged values.
 */
export function mergeOwnerSettings(base: unknown, override: unknown): unknown {
  if (!object(base) || !object(override)) return structuredClone(override)
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    Object.defineProperty(result, key, {
      value: mergeOwnerSettings(result[key], value), enumerable: true, configurable: true, writable: true,
    })
  }
  return result
}

/** Resolve released section names to the owning plugin entry, with canonical values taking precedence.
 * @param sections Released settings document.
 * @param id Current plugin entry id.
 * @returns Merged aliases and canonical values, or an empty object.
 */
export function ownerSettingsSection(sections: Record<string, unknown>, id: string): Record<string, unknown> {
  let result: unknown = {}
  for (const [alias, entry] of Object.entries(aliases)) {
    if (entry === id && Object.hasOwn(sections, alias)) result = mergeOwnerSettings(result, sections[alias])
  }
  if (Object.hasOwn(sections, id)) result = mergeOwnerSettings(result, sections[id])
  return result as Record<string, unknown>
}

/** Persist only differences, so inherited expressions and defaults remain owned by their original layers.
 * @param base Inherited raw plugin configuration.
 * @param next Complete raw configuration after the edit.
 * @returns Sparse settings override.
 */
export function ownerSettingsOverride(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(next)) {
    if (isDeepStrictEqual(base[key], value)) continue
    const delta = object(base[key]) && object(value) ? ownerSettingsOverride(base[key], value) : value
    Object.defineProperty(result, key, { value: delta, enumerable: true, configurable: true, writable: true })
  }
  return result
}

/** Replace only the edited section while retaining settings for unavailable plugins.
 * @param sections Current settings document.
 * @param id Edited plugin entry id.
 * @param next Sparse replacement values.
 * @returns Detached document with obsolete aliases removed for this entry.
 */
export function replaceOwnerSettingsSection(
  sections: Record<string, unknown>, id: string, next: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(sections)
  for (const [alias, entry] of Object.entries(aliases)) if (entry === id) Reflect.deleteProperty(result, alias)
  Object.defineProperty(result, id, { value: next, enumerable: true, configurable: true, writable: true })
  return result
}
