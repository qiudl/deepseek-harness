/** REQ-20260930-0004: original Profile worker communication through public handles. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseHostCollaborationDeliveryCapsule, parseHostCollaborationSourceTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import type { ProfileWorkerHandle } from '../src/types.ts'

const target = parseHostCollaborationSourceTarget({ workspace_id: '123e4567-e89b-42d3-a456-426614174000',
  session_id: 'session', source_message_id: 'message', source_revision: '1' })
const descriptor = { ...target, snapshot_digest: 'a'.repeat(64) }
const snapshot = { descriptor, snapshot_json: JSON.stringify({ ...target, original_message: '@Guide · Project repair',
  active_mentions: [], model_snapshot: { provider: 'deepseek', model: 'chat' },
  host_journal_commit: { journal_id: 'source-journal', commit_version: '1', content_digest: 'b'.repeat(64) },
}) }
const command = { action: 'prepare', input: { source_message_id: target.source_message_id } }
const capsule = parseHostCollaborationDeliveryCapsule({ namespace_id: 'namespace', projection: {
  delivery_id: 'delivery', invocation_id: 'invocation', plan_id: 'plan', task_id: 'task', task_revision: '1',
  source_locator: target, source_snapshot_digest: descriptor.snapshot_digest, execution_state: 'succeeded',
  invocation_state_version: '2', answer: 'repaired',
  result_digest: createHash('sha256').update(JSON.stringify({ answer: 'repaired', failure_code: null, state: 'succeeded' })).digest('hex'),
  target: { project_id: 'project', agent_id: 'agent' }, target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
  delivery_state: 'pending', delivery_state_version: '1',
} })

async function harness(selectionRedirect?: string) {
  const root = mkdtempSync(join(tmpdir(), 'req-collaboration-worker-'))
  const acquired: { worker?: ProfileWorkerHandle } = {}
  onTestFinished(async () => {
    try {
      const worker = acquired.worker
      if (worker) { worker.closeNotifications(); worker.abort(); await worker.done }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const executable = join(root, 'worker.mjs')
  writeFileSync(executable, `
    import { createServer } from 'node:http'
    const descriptor = ${JSON.stringify(descriptor)}
    const snapshot = ${JSON.stringify(snapshot)}
    const selectionRedirect = ${JSON.stringify(selectionRedirect ?? null)}
    const tokens = {
      '/internal/desktop-workspace-model-selection': 'DSH_PROFILE_WORKSPACE_MODEL_TOKEN',
      '/internal/desktop-collaboration-source': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-collaboration-reference-grant': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-collaboration-reference-capture': 'DSH_PROFILE_REFERENCE_TOKEN',
      '/internal/desktop-collaboration-source-snapshot': 'DSH_PROFILE_SOURCE_TOKEN',
      '/internal/desktop-collaboration-analysis': 'DSH_PROFILE_ANALYSIS_TOKEN',
      '/internal/desktop-collaboration-delivery': 'DSH_PROFILE_DELIVERY_TOKEN',
    }
    const cookieName = 'dsh-auth-' + 'a'.repeat(43), cookieValue = 'v1.' + 'b'.repeat(8) + '.' + 'c'.repeat(43)
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/__fixture/exit' && request.headers.cookie === cookieName + '=' + cookieValue) {
        response.writeHead(200).end()
        server.closeAllConnections(); server.close(() => process.exit(0)); return
      }
      if (tokens[url.pathname]) {
        if (request.headers.authorization !== 'Bearer ' + process.env[tokens[url.pathname]]) {
          response.writeHead(403).end(); return
        }
        if (selectionRedirect && url.pathname === '/internal/desktop-workspace-model-selection') {
          response.writeHead(307, { location: selectionRedirect }).end(); return
        }
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const value = url.pathname.endsWith('reference-capture') ? { untrusted_selection: input,
            independent_reference_capability: process.env.DSH_PROFILE_REFERENCE_TOKEN !== process.env.DSH_PROFILE_SOURCE_TOKEN }
          : url.pathname.endsWith('reference-grant') ? { ...descriptor, reference_request_digest: input.reference_request_digest }
          : url.pathname.endsWith('source-snapshot') ? snapshot
          : url.pathname.endsWith('source') ? descriptor
          : url.pathname.endsWith('model-selection') ? { ...input, provider: 'deepseek', model: 'chat' }
          : url.pathname.endsWith('analysis') ? { value: input }
          : { delivery_id: input.projection.delivery_id }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)); return
      }
      if (url.searchParams.get('token') === 'fixture-bootstrap') {
        response.writeHead(303, { location: '/', 'set-cookie': cookieName + '=' + cookieValue
          + '; Max-Age=60; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict' }).end(); return
      }
      response.writeHead(request.headers.cookie === cookieName + '=' + cookieValue ? 200 : 401).end()
    })
    server.listen(0, '127.0.0.1', () => {
      console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fixture-bootstrap')
    })
    process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
  `, { mode: 0o600 })
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: executable,
    attestListener: async (pid, origin) => {
      expect(pid).toBeGreaterThan(0)
      expect((await fetch(origin)).status).toBe(401)
    },
  })
  const worker = await factory.create({ profileId: 'profile', profileRoot: root, credentialHandle: 'fixture-key', pluginRoots: [], env: {} })
  acquired.worker = worker
  const { inspectCollaborationSource, readCollaborationSourceSnapshot, collaborationAnalysis,
    receiveCollaborationDelivery, inspectWorkspaceModelSelection, readCollaborationReferenceGrant,
    captureCollaborationReferenceSelection } = worker
  if (!inspectCollaborationSource || !readCollaborationSourceSnapshot || !collaborationAnalysis
    || !receiveCollaborationDelivery || !inspectWorkspaceModelSelection || !readCollaborationReferenceGrant
    || !captureCollaborationReferenceSelection) throw new Error('missing private worker capability')
  return { worker, inspectCollaborationSource, readCollaborationSourceSnapshot, collaborationAnalysis,
    receiveCollaborationDelivery, inspectWorkspaceModelSelection, readCollaborationReferenceGrant, captureCollaborationReferenceSelection }
}

it('authenticates each original-Profile route and refuses private operations after worker shutdown', async () => {
  const h = await harness(), signal = new AbortController().signal
  for (const route of ['source', 'source-snapshot', 'reference-grant', 'reference-capture', 'analysis', 'delivery'])
    expect((await fetch(`${h.worker.viewOrigin}/internal/desktop-collaboration-${route}`, { method: 'POST' })).status).toBe(403)
  expect(await h.inspectCollaborationSource(target, signal)).toEqual(descriptor)
  const digest = descriptor.snapshot_digest as Parameters<typeof h.readCollaborationReferenceGrant>[1]
  expect(await h.readCollaborationReferenceGrant(target, digest, signal)).toEqual({ ...descriptor, reference_request_digest: digest })
  expect(await h.readCollaborationSourceSnapshot(target, signal)).toEqual(snapshot)
  expect(await h.collaborationAnalysis(command, signal)).toEqual(command)
  expect(await h.captureCollaborationReferenceSelection(command, signal))
    .toEqual({ untrusted_selection: command, independent_reference_capability: true })
  expect(await h.receiveCollaborationDelivery(capsule, signal)).toEqual({ delivery_id: 'delivery' })
  const selection = { workspace_id: target.workspace_id, session_id: target.session_id }
  expect(await h.inspectWorkspaceModelSelection(selection, signal)).toEqual({ ...selection, provider: 'deepseek', model: 'chat' })
  h.worker.abort()
  for (const run of [() => h.inspectCollaborationSource(target, signal), () => h.readCollaborationSourceSnapshot(target, signal),
    () => h.collaborationAnalysis(command, signal), () => h.receiveCollaborationDelivery(capsule, signal),
    () => h.readCollaborationReferenceGrant(target, digest, signal),
    () => h.captureCollaborationReferenceSelection(command, signal),
    () => h.inspectWorkspaceModelSelection(selection, signal)])
    await expect(run()).rejects.toMatchObject({ code: 'unavailable' })
  await h.worker.done
})

it('rejects malformed private analysis envelopes and request/response byte overflows', async () => {
  const h = await harness(), signal = new AbortController().signal
  const response = vi.spyOn(globalThis, 'fetch')
  try {
    for (const value of [null, [], 1, {}, { extra: {} }, { value: {}, extra: true }]) {
      response.mockResolvedValueOnce(new Response(JSON.stringify(value)))
      await expect(h.collaborationAnalysis(command, signal)).rejects.toMatchObject({ code: 'unavailable' })
    }
    for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(128 * 1024 + 1)]) {
      response.mockResolvedValueOnce(new Response(bytes))
      await expect(h.collaborationAnalysis(command, signal)).rejects.toMatchObject({ code: 'unavailable' })
    }
    const large = { inputs: Array.from({ length: 33 }, () => 'x'.repeat(32768)) }
    const calls = response.mock.calls.length
    await expect(h.collaborationAnalysis(large, signal)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(h.receiveCollaborationDelivery({ ...capsule, projection: { ...capsule.projection,
      answer: 'x'.repeat(1024 * 1024 + 1) } }, signal)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(response.mock.calls).toHaveLength(calls)
  } finally { response.mockRestore() }
})

it('rejects foreign Source coordinates and malformed complete snapshots before admitting original content', async () => {
  const h = await harness(), signal = new AbortController().signal, response = vi.spyOn(globalThis, 'fetch')
  try {
    for (const change of [{ workspace_id: '223e4567-e89b-42d3-a456-426614174000' }, { session_id: 'other' },
      { source_message_id: 'other' }, { source_revision: '2' }]) {
      response.mockResolvedValueOnce(new Response(JSON.stringify({ ...descriptor, ...change })))
      await expect(h.inspectCollaborationSource(target, signal)).rejects.toMatchObject({ code: 'profile_mismatch' })
    }
    response.mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, snapshot_json: '{' })))
    await expect(h.readCollaborationSourceSnapshot(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    response.mockResolvedValueOnce(new Response(JSON.stringify({ ...descriptor, reference_request_digest: 'c'.repeat(64) })))
    await expect(h.readCollaborationReferenceGrant(target, 'b'.repeat(64) as never, signal))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    response.mockResolvedValueOnce(new Response(JSON.stringify({ workspace_id: target.workspace_id, session_id: 'other',
      provider: 'deepseek', model: 'chat' })))
    await expect(h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id, session_id: target.session_id }, signal))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id,
      session_id: target.session_id }, AbortSignal.abort()))
      .rejects.toMatchObject({ name: 'AbortError' })
  } finally { response.mockRestore() }
})

it('contains failed, missing, oversized or disconnected private responses and detaches failed reader cancellation', async () => {
  const h = await harness(), signal = new AbortController().signal, response = vi.spyOn(globalThis, 'fetch')
  try {
    await expect(h.captureCollaborationReferenceSelection('😀'.repeat(8192), signal))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(response).not.toHaveBeenCalled()
    for (const reply of [new Response('{}', { status: 503 }), new Response(null), new Response(Buffer.alloc(8193)),
      new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('wire disconnected')) } }))]) {
      response.mockResolvedValueOnce(reply)
      await expect(h.inspectCollaborationSource(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    }
    response.mockResolvedValueOnce(new Response(Buffer.alloc(2 * 1024 * 1024 + 1)))
    await expect(h.readCollaborationSourceSnapshot(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    response.mockResolvedValueOnce(new Response(Buffer.alloc(8193)))
    await expect(h.receiveCollaborationDelivery(capsule, signal)).rejects.toMatchObject({ code: 'unavailable' })
    const cancel = vi.fn().mockRejectedValue(new Error('reader cancellation failed'))
    response.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.alloc(8193)) }, cancel,
    })))
    await expect(h.inspectCollaborationSource(target, signal)).rejects.toMatchObject({ code: 'unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
  } finally { response.mockRestore() }
})

it('preserves owner cancellation during an in-flight private read and rejects a worker stopped at EOF', async () => {
  const h = await harness(), response = vi.spyOn(globalThis, 'fetch')
  try {
    const cancellation = new AbortController(), revoked = new Error('origin revoked')
    response.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { cancellation.abort(revoked); controller.error(revoked) },
    })))
    await expect(h.inspectCollaborationSource(target, cancellation.signal)).rejects.toBe(revoked)
    response.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.from(JSON.stringify(descriptor))); controller.close(); h.worker.abort() },
    })))
    await expect(h.inspectCollaborationSource(target, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
  } finally { response.mockRestore() }
})

it.each(['source', 'selection'])('retains the %s read deadline when the response reaches EOF', async (operation) => {
  const h = await harness(), deadline = new AbortController()
  const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const response = vi.spyOn(globalThis, 'fetch')
  try {
    const selection = { workspace_id: target.workspace_id, session_id: target.session_id, provider: 'deepseek', model: 'chat' }
    response.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from(JSON.stringify(operation === 'source' ? descriptor : selection)))
        controller.close()
        deadline.abort(new DOMException('private read deadline elapsed', 'TimeoutError'))
      },
    })))
    const owner = new AbortController().signal
    const pending = operation === 'source' ? h.inspectCollaborationSource(target, owner)
      : h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id, session_id: target.session_id }, owner)
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    expect(owner.aborted).toBe(false)
    expect(timer).toHaveBeenCalledWith(15000)
  } finally { response.mockRestore(); timer.mockRestore() }
})

it('discards all private capabilities after a worker exits without an abort request', async () => {
  const h = await harness(), { bootstrapCookie: cookie } = h.worker
  if (!cookie) throw new Error('missing worker bootstrap cookie')
  await fetch(`${h.worker.viewOrigin}/__fixture/exit`, { headers: { cookie: `${cookie.name}=${cookie.value}` } })
  await h.worker.done
  const signal = new AbortController().signal
  for (const run of [() => h.inspectCollaborationSource(target, signal), () => h.readCollaborationSourceSnapshot(target, signal),
    () => h.collaborationAnalysis(command, signal), () => h.receiveCollaborationDelivery(capsule, signal)])
    await expect(run()).rejects.toMatchObject({ code: 'unavailable' })
})

it('refuses a redirected private model-selection response before sending original Session coordinates to another listener', async () => {
  const forwarded: { method: string | undefined; body: string }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('error', (error) => { response.destroy(error) })
    request.on('end', () => {
      forwarded.push({ method: request.method, body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        workspace_id: target.workspace_id, session_id: target.session_id, provider: 'redirected', model: 'unattested',
      }))
    })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing redirect listener')
  const h = await harness(`http://127.0.0.1:${address.port}/selection`)
  await expect(h.inspectWorkspaceModelSelection({ workspace_id: target.workspace_id,
    session_id: target.session_id }, new AbortController().signal)).rejects.toThrow()
  expect(forwarded).toEqual([])
})

it('refuses an ambient Reference capability before opening any Profile directory or process', async () => {
  const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: '/owned-test/entry.mjs' })
  await expect(factory.create({ profileId: 'test', profileRoot: '/not-opened', credentialHandle: 'opaque', pluginRoots: [],
    env: { DSH_PROFILE_REFERENCE_TOKEN: 'injected' } })).rejects.toMatchObject({ code: 'invalid_input' })
})
