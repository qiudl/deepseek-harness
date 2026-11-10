import assert from 'node:assert/strict'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const coordinate = value => typeof value === 'string' && /^[!-~]{1,256}$/.test(value) &&
  !/[/\\]/.test(value) && value !== '.' && value !== '..'
const sqlRows = statement => {
  statement.setReadBigInts(true)
  return statement.all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, typeof value === 'bigint' ? value.toString() : value])))
}

/**
 * Attach the reviewed production observer and actual Bot owner store to the
 * caller's existing isolated Host Context. No source/authority DTOs are made.
 * Dispose this child before removing root; the caller owns root and the Host.
 * SQLite integers in readJournal() are exact decimal strings, safe for JSON.
 */
export async function attachDsBotOperationObserver({ ctx, root, profileId, botId, sessionId, dsBotRoot, dsBotCommit }) {
  assert(isAbsolute(root), 'root must be the caller-owned absolute isolated fixture directory')
  const isolatedRoot = await realpath(root)
  assert((await stat(isolatedRoot)).isDirectory())
  assert(coordinate(profileId) && coordinate(sessionId))
  assert(typeof botId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(botId))
  assert.equal(process.env.DSH_PROFILE_ID, profileId, 'use the actual frozen Host Profile')
  assert.equal(typeof ctx?.plugin, 'function')
  assert.equal(typeof ctx.sessions?.get, 'function')
  assert.equal(typeof ctx.sessionPersistence?.open, 'function')
  assert.equal(typeof ctx.tools?.guard, 'function')
  assert.equal(typeof ctx.get('projectOperationOrigins')?.read, 'function', 'the actual Host origin reader must already exist')
  assert.equal(ctx.get('dsBotSlarkExternalGroup'), undefined, 'remove the fixture producer before attaching the actual producer')
  const session = ctx.sessions.get(sessionId)
  assert(session && session.id === sessionId, 'the caller must already own the actual live Session')

  assert(isAbsolute(dsBotRoot), 'select the reviewed DSBot repository explicitly')
  const repository = await realpath(dsBotRoot)
  if (dsBotCommit !== undefined) {
    assert.match(dsBotCommit, /^[a-f0-9]{40}$/)
    const result = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' })
    assert.equal(result.stdout.trim(), dsBotCommit, 'the selected DSBot tree must match the reviewed commit')
  }
  const modules = ['store', 'external-group', 'project-operations'].map(name =>
    pathToFileURL(join(repository, 'src', 'host', name + '.js')).href)
  const [store, externalGroup, projectOperations] = await Promise.all(modules.map(path => import(path)))
  const home = join(isolatedRoot, 'bot')
  await mkdir(home, { mode: 0o700 })
  const statePath = join(home, 'state.json'), journalPath = join(home, 'project-operations.sqlite')
  await writeFile(statePath, JSON.stringify({ version: 1, revision: 1, mainBotIds: [botId],
    bots: { [botId]: { id: botId, sessionId, name: 'Origin fixture Bot', role: '', instructions: '', createdAt: 1 } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, whaleStored: true,
  }), { flag: 'wx', mode: 0o600 })

  let rt, disposed = false
  const fiber = ctx.plugin({ name: 'actual-dsbot-origin-observer-integration',
    inject: ['sessions', 'sessionPersistence', 'tools'],
    async apply(child) {
      rt = { ctx: child, home, statePath, config: { slarkExternalGroup: true }, defaults: {}, warn() {} }
      store.install(rt)
      await rt.load()
      assert.equal(rt.hasExclusiveWriter(), true)
      assert.equal(rt.isBotSession(sessionId), true)
      assert.equal(rt.selfOf(sessionId), botId)
      assert.equal(child.sessions.get(sessionId), session)
      externalGroup.install(rt)
      projectOperations.install(rt)
    },
  })
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await fiber.dispose()
  }
  try {
    await fiber.await()
    assert(rt?.projectOperationObserver, 'the actual production observer must mount')
    await rt.projectOperationObserver.settled()
    assert.equal(rt.hasExclusiveWriter(), true)
    assert.equal(rt.selfOf(sessionId), botId)
    assert.deepEqual(await ctx.get('dsBotSlarkExternalGroup').describeLocalBotSession({ sessionId }), { botId, sessionId })
    return Object.freeze({
      rt,
      async settled() {
        assert.equal(disposed, false)
        await rt.projectOperationObserver.settled()
      },
      readJournal() {
        const db = new DatabaseSync(journalPath, { readOnly: true })
        try {
          return {
            meta: sqlRows(db.prepare('SELECT * FROM journal_meta'))[0],
            records: sqlRows(db.prepare('SELECT * FROM operation_records ORDER BY sequence')),
            revisions: sqlRows(db.prepare('SELECT * FROM operation_revisions ORDER BY sequence')),
            checkpoints: sqlRows(db.prepare('SELECT * FROM session_checkpoints ORDER BY profile_id,bot_root_id,session_id')),
          }
        } finally { db.close() }
      },
      dispose,
    })
  } catch (error) {
    await dispose()
    throw error
  }
}
