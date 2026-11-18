import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as archive } from 'tar'
import { expect, it as test, onTestFinished } from 'vitest'
import { BundledPluginCatalog } from '../src/bundled-plugins.ts'
import { BotUpgradeGenerations } from '../src/bot-upgrade-generation.ts'
import { verifyBundledBotStoreCopy } from '../src/slark-bot-upgrade-reader.ts'

const it = test.skipIf(process.platform === 'win32') // Uses the POSIX owner-private archive and data channel.

async function fixture(scenario = 'preserved') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bot-upgrade-reader-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const uid = process.getuid!(), profile = join(root, 'profile'), home = join(profile, 'bot'),
    control = join(root, 'control'), resources = join(root, 'resources'), staging = join(root, 'staging'),
    pkg = join(staging, 'package'), web = join(profile, 'profiles/web')
  for (const path of [home, control, resources, join(pkg, 'src/host'), join(web, 'node_modules')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  const before = JSON.stringify({ version: 1, revision: 1, mainBotIds: ['b'], bots: { b: { id: 'b', name: 'Fixture' } }, rooms: {} })
  await writeFile(join(home, 'state.json'), before, { mode: 0o600 })
  const extra: Record<string, string> = {
    preserved: "rt.warn();rt.ctx.effect(()=>undefined);rt.state.observedName=rt.autoRoomName(['b','missing']);rt.keepGroupLine('r',{text:'short'},'short');",
    retitle: 'await rt.retitleRoom();', long: "rt.keepGroupLine('r',{},'x'.repeat(2001));",
    effect: 'rt.ctx.effect(()=>42);', dispose: "rt.ctx.effect(()=>async()=>{await writeFile(rt.home+'/closed.txt','done')});rt.ctx.effect(()=>()=>{throw Error('close failed')});",
    'tamper reader': "rt.save=async()=>{await writeFile(new URL('./constants.js',import.meta.url),'changed reader')};",
    'tamper install': `rt.save=async()=>{await writeFile(${JSON.stringify(join(web, 'node_modules/ds-bot/src/host/constants.js'))},'changed install')};`,
    missing: 'delete rt.save;', exclusive: 'rt.hasExclusiveWriter=()=>false;', readonly: "rt.readOnly=()=> 'unavailable';",
  }
  const store = scenario === 'invalid module' ? 'export const install=42;' : `
import {readFile,writeFile} from 'node:fs/promises';
export function install(rt){
 ${scenario === 'preserved' ? "rt.autoRoomName(['b']);rt.state={};rt.autoRoomName(['b']);" : ''}
 rt.ctx.effect(()=>()=>Promise.resolve());
 rt.load=async()=>{rt.state=JSON.parse(await readFile(rt.statePath,'utf8'));${extra[scenario] ?? ''}};
 rt.save=async()=>{await writeFile(rt.statePath,JSON.stringify(rt.state));};
 rt.hasExclusiveWriter=()=>true;rt.readOnly=()=>undefined;
}
`
  await writeFile(join(pkg, 'src/host/store.js'), store, { mode: 0o600 })
  await writeFile(join(pkg, 'src/host/constants.js'), `export const TEXT_KEPT=${scenario === 'invalid constants' ? '0' : '2000'};`, { mode: 0o600 })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ type: 'module', name: 'ds-bot', version: '0.3.8-slark.1' }), { mode: 0o600 })
  const file = 'ds-bot.tgz'
  await archive({ cwd: staging, file: join(resources, file), gzip: true }, ['package'])
  const pluginRow = { name: 'ds-bot', version: '0.3.8-slark.1', file,
    sha256: createHash('sha256').update(await readFile(join(resources, file))).digest('hex'),
    entryIds: ['bot'], repository: 'https://example.com/fixture', sourceSha: '1'.repeat(40) }
  await writeFile(join(resources, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [pluginRow] }), { mode: 0o600 })
  const catalog = BundledPluginCatalog.load(resources, uid), plugin = catalog.get('ds-bot', pluginRow.version)!
  catalog.materialize(plugin, web)
  await cp(pkg, join(web, 'node_modules/ds-bot'), { recursive: true })
  const generations = new BotUpgradeGenerations(profile, control, uid), generation = generations.prepare(randomUUID(), () => {})
  return { home, before, control, generation,
    options: { profileRoot: profile, controlRoot: control, uid, catalog, plugin, generations, generation, guard() {} } }
}

it('executes only the verified store with its helpers and accepts an identical repeated private probe', async () => {
  const f = await fixture()
  await verifyBundledBotStoreCopy(f.options)
  await verifyBundledBotStoreCopy(f.options)
  const state: unknown = JSON.parse(await readFile(join(f.generation.candidateHome, 'state.json'), 'utf8'))
  expect(state).toMatchObject({ observedName: 'You, Fixture' })
  expect(await readFile(join(f.home, 'state.json'), 'utf8')).toBe(f.before)
})

it.each([
  ['invalid module', 'bot_upgrade_reader_incompatible'], ['invalid constants', 'bot_upgrade_reader_incompatible'],
  ['retitle', 'bot_upgrade_session_conversion_required'], ['long', 'bot_upgrade_history_conversion_required'],
  ['effect', 'bot_upgrade_reader_incompatible'], ['dispose', 'bot_upgrade_reader_shutdown_failed'],
  ['missing', 'bot_upgrade_reader_incompatible'], ['exclusive', 'bot_upgrade_reader_not_writable'],
  ['readonly', 'bot_upgrade_reader_not_writable'],
  ['tamper reader', 'bot_upgrade_reader_changed'], ['tamper install', 'runtime_incompatible'],
])('refuses %s without changing original data', async (scenario, code) => {
  const f = await fixture(scenario)
  await expect(verifyBundledBotStoreCopy(f.options)).rejects.toThrow(code)
  if (scenario === 'dispose') await expect(readFile(join(f.generation.candidateHome, 'closed.txt'), 'utf8')).resolves.toBe('done')
  expect(await readFile(join(f.home, 'state.json'), 'utf8')).toBe(f.before)
})

it('refuses a changed retained reader and a package outside this data adapter', async () => {
  const f = await fixture()
  await verifyBundledBotStoreCopy(f.options)
  await writeFile(join(f.control, 'reader/src/host/store.js'), 'changed reader', { mode: 0o600 })
  await expect(verifyBundledBotStoreCopy(f.options)).rejects.toThrow('bot_upgrade_reader_changed')
  await expect(verifyBundledBotStoreCopy({ ...f.options, plugin: { ...f.options.plugin, name: 'other' } }))
    .rejects.toThrow('bot_upgrade_reader_incompatible')
  expect(await readFile(join(f.home, 'state.json'), 'utf8')).toBe(f.before)
})
