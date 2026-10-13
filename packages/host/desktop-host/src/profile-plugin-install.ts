import { join } from 'node:path'
import type { BundledPluginCatalog } from './bundled-plugins.ts'
import { runProfilePluginCommand, type ProfilePluginCommand } from './plugin-command.ts'

/**
 * Materialize an embedding-owned archive before installing a confirmed plugin source.
 * @param input Host-selected binaries, Profile and operation authority.
 * @param catalog Optional verified embedding catalog for bundled sources.
 * @returns Completion of the package command; runtime acknowledgement remains separate.
 */
export async function runProfilePluginInstall(input: ProfilePluginCommand, catalog?: BundledPluginCatalog): Promise<void> {
  input.guard(); input.signal.throwIfAborted()
  const archivePath = catalog?.archiveFor(input.spec, join(input.profileRoot, 'profiles', 'web'))
  return runProfilePluginCommand({ ...input, ...(archivePath ? { archivePath } : {}) })
}
