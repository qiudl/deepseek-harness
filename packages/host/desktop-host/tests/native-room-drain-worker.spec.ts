import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { expect, it, onTestFinished } from 'vitest'
import { parseHostBoundBotRoomsQuery } from '@deepseek-ai/dsh-host-control-protocol'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import type { ProfileWorkerHandle } from '../src/types.ts'

it('shares factory slots across workers and treats process errors as failure without claiming process exit', async () => {
  let terminal = false
  const server = createServer((req, res) => {
    if (terminal) res.setHeader('x-dsh-native-settled', String(req.headers['x-dsh-native-drain']))
    res.end(JSON.stringify({ state: 'bot_unavailable' }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('missing owned listener')
  const origin = `http://127.0.0.1:${address.port}`
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath })
  const handle = Reflect.get(factory, 'handle') as (child: ChildProcess, origin: string,
    cookie: { name: string; value: string }, generation: number, ...tokens: string[]) => ProfileWorkerHandle
  const children: ChildProcess[] = [], exits: Promise<void>[] = [], completions: Promise<unknown>[] = []
  const create = (generation: number) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    exits.push(new Promise<void>((resolve) => { child.once('exit', () =>{  resolve() }) }))
    const worker = handle.call(factory, child, origin, { name: 'fixture', value: 'fixture' }, generation,
      ...Array.from({ length: 9 }, () => 'A'.repeat(43)))
    const done = worker.done.catch((error: unknown) => error)
    completions.push(done)
    return { worker, child, done }
  }
  onTestFinished(async () => {
    for (const child of children) child.kill('SIGKILL')
    await Promise.all(exits)
    await Promise.all(completions)
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() =>{  resolve() }) })
  })
  const first = create(1), replacement = create(2)
  const query = parseHostBoundBotRoomsQuery({ bot_id: 'operator', limit: 1, cursor: null })
  const read = (worker: ProfileWorkerHandle) => {
    if (!worker.listBoundBotRooms) throw Error('missing native inventory method')
    return worker.listBoundBotRooms(query, new AbortController().signal)
  }
  for (let index = 0; index < 8; index++) await expect(read(first.worker)).rejects.toMatchObject({ code: 'upgrade_required' })
  await expect(read(replacement.worker)).rejects.toMatchObject({ code: 'busy' })
  const failure = Error('owned child error before exit')
  first.child.emit('error', failure)
  if (first.child.pid === undefined) throw Error('owned child did not spawn')
  expect(() => process.kill(first.child.pid!, 0)).not.toThrow()
  expect(await Promise.race([first.done.then(() => 'early completion'),
    fetch(origin).then(async (response) => { await response.text(); return 'process remains live' })]))
    .toBe('process remains live')
  await expect(read(replacement.worker)).rejects.toMatchObject({ code: 'busy' })
  first.worker.abort()
  await exits[0]
  expect(await first.done).toBe(failure)
  terminal = true
  expect(await read(replacement.worker)).toEqual({ state: 'bot_unavailable' })
  replacement.worker.abort()
  await replacement.done
})
