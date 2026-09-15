import AdmZip from 'adm-zip'
import { expect, it } from 'vitest'
import { inspectSkillArchive } from '../src/skill-archive.ts'
const markdown = '---\nname: demo\ndescription: Test archive\nlicense: MIT\n---\nUse scripts/run.sh and references/guide.md.\n'
function zip(files: Record<string, string>): Buffer {
  const archive = new AdmZip()
  for (const [name, value] of Object.entries(files)) archive.addFile(name, Buffer.from(value))
  return archive.toBuffer()
}
it('retains original metadata and every resource in the selected skill directory', () => {
  const archive = zip({ 'repo-main/skills/demo/SKILL.md': markdown, 'repo-main/skills/demo/scripts/run.sh': 'echo demo',
    'repo-main/skills/demo/references/guide.md': 'Guide', 'repo-main/other.txt': 'Outside' })
  const bundle = inspectSkillArchive(archive, 'skills/demo', 'demo')
  expect(bundle.markdown).toBe(markdown)
  expect(bundle.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'references/guide.md', 'scripts/run.sh'])
})
it('rejects ambiguous roots, wrong names and path traversal before publication', () => {
  expect(() => inspectSkillArchive(zip({ 'repo-main/a/SKILL.md': markdown, 'repo-main/b/SKILL.md': markdown }), '', 'demo')).toThrow()
  expect(() => inspectSkillArchive(zip({ 'repo-main/SKILL.md': markdown }), '', 'another')).toThrow()
  const traversal = zip({ 'repo-main/SKILL.md': markdown, 'repo-main/xx/escape': 'outside' })
  for (let offset = traversal.indexOf('repo-main/xx/escape'); offset >= 0; offset = traversal.indexOf('repo-main/xx/escape')) {
    traversal.write('repo-main/../escape', offset)
  }
  expect(() => inspectSkillArchive(traversal, '', 'demo')).toThrow()
})
it('accepts a root SKILL.md and rejects case collisions and symbolic links', () => {
  expect(inspectSkillArchive(zip({ 'SKILL.md': markdown }), '', 'demo').files).toHaveLength(1)
  expect(() => inspectSkillArchive(zip({ 'SKILL.md': markdown, 'Guide.md': 'one', 'guide.md': 'two' }), '', 'demo')).toThrow()
  const archive = new AdmZip(zip({ 'SKILL.md': markdown, 'link': '../outside' }))
  archive.getEntry('link')!.attr = (0o120777 << 16) >>> 0
  expect(() => inspectSkillArchive(archive.toBuffer(), '', 'demo')).toThrow()
})
it('preserves executable resources and rejects file-directory collisions', () => {
  const archive = new AdmZip(zip({ 'SKILL.md': markdown, 'scripts/run.sh': 'echo demo' }))
  archive.getEntry('scripts/run.sh')!.attr = (0o100755 << 16) >>> 0
  expect(inspectSkillArchive(archive.toBuffer(), '', 'demo').files.find(file => file.path === 'scripts/run.sh')?.executable).toBe(true)
  expect(() => inspectSkillArchive(zip({ 'SKILL.md': markdown, 'scripts': 'file', 'scripts/run.sh': 'echo demo' }), '', 'demo')).toThrow('archive_path_collision')
})
it('bounds declared expansion and rejects deflate content hidden behind a zero size', () => {
  const data = zip({ 'SKILL.md': markdown, 'resource': 'x'.repeat(1024) })
  const central = Buffer.from([0x50, 0x4b, 0x01, 0x02]); const local = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const oversized = Buffer.from(data)
  oversized.writeUInt32LE(10 * 1024 * 1024 + 1, oversized.indexOf(central) + 24)
  expect(() => inspectSkillArchive(oversized, '', 'demo')).toThrow('archive_limit')
  for (let offset = data.indexOf(central); offset >= 0; offset = data.indexOf(central, offset + 4)) data.writeUInt32LE(0, offset + 24)
  for (let offset = data.indexOf(local); offset >= 0; offset = data.indexOf(local, offset + 4)) data.writeUInt32LE(0, offset + 22)
  expect(() => inspectSkillArchive(data, '', 'demo')).toThrow()
})

it('rejects invalid selections and entry-count limits before extracting files', () => {
  expect(() => inspectSkillArchive(zip({ 'SKILL.md': markdown }), '../outside', 'demo')).toThrow('invalid_archive')
  expect(() => inspectSkillArchive(zip({}), '', 'demo')).toThrow('archive_limit')
  const files = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`file-${index}`, 'x']))
  expect(() => inspectSkillArchive(zip(files), '', 'demo')).toThrow('archive_limit')
})

it('selects a unique nested skill while retaining only its own resources', () => {
  const result = inspectSkillArchive(zip({ 'repo/nested/SKILL.md': markdown, 'repo/other.txt': 'outside' }), '', 'demo')
  expect(result.files.map(file => file.path)).toEqual(['SKILL.md'])
})

it('bounds total declared expansion across individually valid entries', () => {
  const files = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`file-${index}`, 'x']))
  const data = zip(files)
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  for (let offset = data.indexOf(signature); offset >= 0; offset = data.indexOf(signature, offset + 4)) {
    data.writeUInt32LE(10 * 1024 * 1024, offset + 24)
  }
  expect(() => inspectSkillArchive(data, '', 'demo')).toThrow('archive_limit')
})

it('rejects expansion whose bytes disagree with the declared size', () => {
  const data = zip({ 'SKILL.md': markdown })
  const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  const local = data.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  data.writeUInt32LE(Buffer.byteLength(markdown) + 1, central + 24)
  data.writeUInt32LE(Buffer.byteLength(markdown) + 1, local + 22)
  expect(() => inspectSkillArchive(data, '', 'demo')).toThrow('archive_size_mismatch')
})

it('rejects a one-byte deflated resource that claims to be empty', () => {
  const archive = new AdmZip(zip({ 'SKILL.md': markdown, 'resource': 'x' }))
  archive.getEntry('resource')!.header.size = 0
  expect(() => inspectSkillArchive(archive.toBuffer(), '', 'demo')).toThrow('archive_size_mismatch')
})

it.each([
  markdown + 'x'.repeat(32768),
  '---\nname: demo\ndescription: Test\nwhenToUse: 42\n---\nBody',
  '---\nname: demo\ndescription: Test\ndisable-model-invocation: yes\n---\nBody',
  '---\nname: demo\ndescription: Test\nuser-invocable: yes\n---\nBody',
])('rejects oversized or invalid Skill instruction metadata: %#', (content) => {
  expect(() => inspectSkillArchive(zip({ 'SKILL.md': content }), '', 'demo')).toThrow('invalid_skill')
})
