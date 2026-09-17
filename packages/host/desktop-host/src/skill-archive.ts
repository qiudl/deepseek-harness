import AdmZip from 'adm-zip'
import { inflateRawSync } from 'node:zlib'
import { parseSkillFile, safeZipRelPath } from '#hub-skills'

/** One validated archive file, retained in memory until Profile publication. */
export interface SkillArchiveFile { path: string; data: Buffer; executable: boolean }
/** Complete selected skill directory with the original frontmatter and resource bytes. */
export interface SkillArchive { markdown: string; files: SkillArchiveFile[] }

/**
 * Inspect a ZIP using Hub path normalization without invoking its default-directory installer.
 * @param buffer Downloaded archive, limited to 50 MiB.
 * @param subPath Explicit repository-relative skill directory, or an unambiguous root selection.
 * @param name Confirmed kebab-case skill name; must match frontmatter.
 * @returns Original Markdown and all files within the selected directory, capped at 512 entries and 100 MiB.
 */
export function inspectSkillArchive(buffer: Buffer, subPath: string, name: string): SkillArchive {
  if (buffer.length > 50 * 1024 * 1024 || (subPath && safeZipRelPath(subPath) !== subPath)) throw Error('invalid_archive')
  const entries = new AdmZip(buffer).getEntries()
  if (!entries.length || entries.length > 512) throw Error('archive_limit')
  let total = 0
  const names = new Set<string>()
  const files = entries.map((entry) => {
    const path = safeZipRelPath(entry.entryName)
    const mode = entry.attr >>> 16
    const type = mode & 0o170000
    if (!path || /[\x00-\x1f\x7f:]/u.test(path)
      || path.split('/').some(part => /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
      || names.has(path.toLowerCase()) || (type !== 0 && type !== (entry.isDirectory ? 0o040000 : 0o100000))
      || entry.header.encrypted) throw Error('unsafe_archive_entry')
    names.add(path.toLowerCase())
    if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || entry.header.size > 10 * 1024 * 1024) throw Error('archive_limit')
    total += entry.header.size
    if (total > 100 * 1024 * 1024) throw Error('archive_limit')
    return { entry, path, executable: (mode & 0o100) !== 0 }
  }).filter(file => !file.entry.isDirectory)
  const filePaths = new Set(files.map(file => file.path.toLowerCase()))
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/')
    for (let i = 1; i < parts.length; i++) if (filePaths.has(parts.slice(0, i).join('/'))) throw Error('archive_path_collision')
  }
  const roots = new Set(files.map(file => file.path.split('/')[0]))
  const wrapper = roots.size === 1 && !files.some(file => file.path === 'SKILL.md') ? `${[...roots][0]}/` : ''
  const expected = `${wrapper}${subPath ? `${subPath}/` : ''}SKILL.md`
  let skill = files.find(file => file.path === expected)
  if (!skill && !subPath) {
    const candidates = files.filter(file => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))
    if (candidates.length === 1) skill = candidates[0]
  }
  if (!skill) throw Error('ambiguous_or_missing_skill')
  const prefix = skill.path.slice(0, -'SKILL.md'.length)
  const selected = files.filter(file => file.path.startsWith(prefix)).map(({ entry, path, executable }) => {
    // AdmZip caps positive declared sizes; explicitly bound the zero-size deflate case too.
    if (entry.header.size === 0 && entry.header.method === 8
      && inflateRawSync(entry.getCompressedData(), { maxOutputLength: 1 }).length !== 0) throw Error('archive_size_mismatch')
    const data = entry.getData()
    if (data.length !== entry.header.size) throw Error('archive_size_mismatch')
    return { path: path.slice(prefix.length), data, executable }
  })
  const instruction = selected.find(file => file.path === 'SKILL.md')
  if (!instruction || instruction.data.length > 32768) throw Error('invalid_skill')
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(instruction.data)
  const { meta, body } = parseSkillFile(markdown)
  if (meta.name !== name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)
    || name.length > 64 || typeof meta.description !== 'string' || !meta.description.trim() || !body.trim() || markdown.includes('\0')
    || meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string'
    || meta['disable-model-invocation'] !== undefined && typeof meta['disable-model-invocation'] !== 'boolean'
    || meta['user-invocable'] !== undefined && typeof meta['user-invocable'] !== 'boolean') throw Error('invalid_skill')
  return { markdown, files: selected }
}
