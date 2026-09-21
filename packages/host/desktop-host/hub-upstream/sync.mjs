// Reproduce the runtime copy without changing upstream source or its license.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'
const root = new URL('./', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('UPSTREAM.json', root), 'utf8'))
for (const [remote, local] of [['src/core/mcp.ts', 'mcp.ts'], ['src/core/skills.ts', 'skills.ts'], ['src/core/plugins.ts', 'plugins.ts'], ['LICENSE', 'LICENSE']]) {
  const hash = createHash('sha256').update(readFileSync(new URL(local, root))).digest('hex')
  if (hash !== manifest.files[remote]) throw new Error(`Pinned upstream file differs: ${local}`)
}
const generated = '// Generated from pinned Desktop Hub mcp.ts; see UPSTREAM.json and LICENSE.\n'
  + ts.transpileModule(readFileSync(new URL('mcp.ts', root), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  }).outputText
if (process.argv.includes('--write')) writeFileSync(new URL('mcp.mjs', root), generated)
else if (readFileSync(new URL('mcp.mjs', root), 'utf8') !== generated) throw new Error('Hub runtime copy is stale')
process.stdout.write('Hub MCP source, license and generated runtime verified.\n')

// Select only the unchanged pure codecs; filesystem/import helpers keep Host-owned authority.
const skillSource = ts.createSourceFile('skills.ts', readFileSync(new URL('skills.ts', root), 'utf8'), ts.ScriptTarget.Latest, true)
const codecNames = ['parseSkillFile', 'renderSkillFile', 'safeZipRelPath', 'parseGitHubSkillUrl']
const codecFunctions = skillSource.statements.filter(statement => ts.isFunctionDeclaration(statement) && codecNames.includes(statement.name?.text))
if (codecFunctions.length !== codecNames.length) throw new Error('Hub skill codec boundary drift')
const invocationFunctions = ['fallbackSkillName', 'setInvocation'].map(name => {
  const fn = skillSource.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!fn) throw new Error('Hub invocation helper drift')
  return fn.getFullText(skillSource)
}).join('\n')
const invocationPure = invocationFunctions
  .replace('setInvocation(path: string,', 'setInvocation(path: string, text: string,')
  .replace("  const text = readFileSync(path, 'utf8')\n", '')
  .replace('  writeFileSync(path, next)\n', '')
if (/readFileSync|writeFileSync/.test(invocationPure)) throw new Error('Hub invocation filesystem boundary drift')
const kebab = skillSource.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(skillSource) === 'KEBAB'))
if (!kebab) throw new Error('Hub skill name pattern drift')
const skillRuntime = '// Generated pure functions from pinned Hub skills.ts; see UPSTREAM.json and LICENSE.\n'
  + ts.transpileModule("import { parseDocument, stringify } from 'yaml'\nimport { basename, dirname } from 'node:path'\n" + kebab.getFullText(skillSource) + '\n' + invocationPure + '\n' + codecFunctions.map(statement => statement.getFullText(skillSource)).join('\n') + '\nexport { safeZipRelPath }\n', {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  }).outputText
if (process.argv.includes('--write')) writeFileSync(new URL('skills-codec.mjs', root), skillRuntime)
else if (readFileSync(new URL('skills-codec.mjs', root), 'utf8') !== skillRuntime) throw new Error('Hub skill codec is stale')
process.stdout.write('Hub skill source and generated pure codecs verified.\n')

const pluginSource = ts.createSourceFile('plugins.ts', readFileSync(new URL('plugins.ts', root), 'utf8'), ts.ScriptTarget.Latest, true)
const commands = pluginSource.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'buildPluginCommand')
if (commands.length !== 1) throw new Error('Hub plugin command boundary drift')
const pluginRuntime = '// Generated pure command builder from pinned Hub plugins.ts; see UPSTREAM.json and LICENSE.\n'
  + ts.transpileModule(commands[0].getFullText(pluginSource), { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText
if (process.argv.includes('--write')) writeFileSync(new URL('plugin-command.mjs', root), pluginRuntime)
else if (readFileSync(new URL('plugin-command.mjs', root), 'utf8') !== pluginRuntime) throw new Error('Hub plugin command is stale')
process.stdout.write('Hub plugin source and pure command builder verified.\n')
