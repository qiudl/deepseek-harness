/**
 * Slark cloud Runtime Cell bundle marker. Provider replacement and authoring
 * removal live in the package's declared `cordis.patch.yml`.
 * @module @deepseek-ai/dsh-slark-cloud
 */

/** Cordis plugin name for direct diagnostic mounts. */
export const name = 'slark-cloud-bundle'

/** The bundle marker has no runtime work outside its patch layer. */
export function apply(): void {}
