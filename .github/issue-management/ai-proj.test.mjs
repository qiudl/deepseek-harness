import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPullRequest, readJson, requirementReferences, runPolicyEvent } from './ai-proj.mjs'

const repository = 'qiudl/deepseek-harness'
const head = 'a'.repeat(40)
const config = { repository, projectId: 212, apiOrigin: 'https://ai.pipexerp.com' }

function fixture({ pull = {}, requirement = {}, links = [], responses = {} } = {}) {
  const calls = []
  const currentPull = {
    number: 40, state: 'open', title: 'fix: REQ-20260930-0005',
    body: 'ai-proj Task 22610', head: { sha: head },
    base: { repo: { full_name: repository } }, ...pull,
  }
  const approved = {
    id: 5846, display_id: 'REQ-20260930-0005', project_id: 212,
    status: 'approved', ...requirement,
  }
  const taskLinks = links.length ? links : [{
    requirement_id: 5846, task_id: 22610, task_project_id: 212,
    task_status: 'in_progress', link_role: 'implementation',
  }]
  const fetchJson = async (url, token) => {
    calls.push({ url: String(url), token })
    const parsed = new URL(url)
    if (String(url) in responses) return responses[String(url)]
    if (parsed.hostname === 'api.github.com') return currentPull
    if (parsed.pathname === '/api/v1/requirements') {
      return { success: true, data: { data: [approved], total: 1 } }
    }
    if (parsed.pathname === '/api/v1/requirements/5846') {
      return { success: true, data: approved }
    }
    if (parsed.pathname === '/api/v1/requirements/5846/tasks') {
      return { success: true, data: { data: taskLinks, total: taskLinks.length } }
    }
    throw new Error('unexpected request')
  }
  return {
    calls, fetchJson,
    run: () => checkPullRequest({
      repository, number: 40, expectedHead: head, config,
      githubToken: 'github-read-token', projectToken: 'project-read-token', fetchJson,
    }),
  }
}

test('accepts an approved project requirement and a cited linked implementation task', async () => {
  const f = fixture()
  assert.deepEqual(await f.run(), { head, requirementIds: [5846], taskIds: [22610] })
  assert.equal(f.calls.filter(c => c.url.includes('api.github.com')).length, 2)
  for (const call of f.calls) {
    assert.equal(call.token, call.url.includes('api.github.com') ? 'github-read-token' : 'project-read-token')
  }
})

test('ignores requirement and task references in comments and code', () => {
  assert.deepEqual(requirementReferences('REQ-20260930-0005',
    '<!-- REQ-20260101-0001 Task 1 -->\n```\nREQ-20260101-0002 Task 2\n```\n`REQ-20260101-0003 Task 3`\nTask 22610'),
  { requirements: ['REQ-20260930-0005'], tasks: [22610] })
})

for (const [name, values, message] of [
  ['missing requirement reference', { pull: { title: 'fix' } }, /requirement reference/],
  ['missing task reference', { pull: { body: '' } }, /task reference/],
  ['unapproved requirement', { requirement: { status: 'pending' } }, /approved/],
  ['wrong requirement project', { requirement: { project_id: 1 } }, /project/],
  ['wrong linked task project', { links: [{ requirement_id: 5846, task_id: 22610, task_project_id: 1, task_status: 'in_progress', link_role: 'implementation' }] }, /implementation task/],
  ['unstarted task', { links: [{ requirement_id: 5846, task_id: 22610, task_project_id: 212, task_status: 'todo', link_role: 'implementation' }] }, /implementation task/],
  ['unlinked cited task', { links: [{ requirement_id: 5846, task_id: 999, task_project_id: 212, task_status: 'in_progress', link_role: 'implementation' }] }, /implementation task/],
  ['verification task used as implementation', { links: [{ requirement_id: 5846, task_id: 22610, task_project_id: 212, task_status: 'completed', link_role: 'verification' }] }, /implementation task/],
  ['wrong repository', { pull: { base: { repo: { full_name: 'other/repo' } } } }, /repository/],
  ['changed head', { pull: { head: { sha: 'b'.repeat(40) } } }, /head/],
  ['closed PR', { pull: { state: 'closed' } }, /open/],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(fixture(values).run(), message)
  })
}

test('rejects project API failures and partial task lists', async () => {
  for (const data of [{ success: false }, { success: true, data: { data: [], total: 101 } }]) {
    await assert.rejects(fixture({ responses: { 'https://ai.pipexerp.com/api/v1/requirements/5846/tasks?page_size=100': data } }).run())
  }
})

test('rejects ambiguous requirement lookup', async () => {
  const url = 'https://ai.pipexerp.com/api/v1/requirements?project_id=212&search=REQ-20260930-0005&page_size=100'
  const row = { id: 5846, display_id: 'REQ-20260930-0005', project_id: 212, status: 'approved' }
  await assert.rejects(fixture({ responses: { [url]: { success: true, data: { data: [row, row], total: 2 } } } }).run(), /lookup/)
})

test('rechecks live PR metadata before delivering a successful result', async () => {
  const f = fixture()
  const options = {
    repository, number: 40, expectedHead: head, config,
    githubToken: 'github-read-token', projectToken: 'project-read-token',
  }
  let githubReads = 0
  options.fetchJson = async (url) => {
    if (String(url).includes('api.github.com')) {
      githubReads++
      return { number: 40, state: 'open', title: 'REQ-20260930-0005', body: githubReads === 1 ? 'Task 22610' : 'Task 1', head: { sha: head }, base: { repo: { full_name: repository } } }
    }
    if (new URL(url).pathname.endsWith('/tasks')) return { success: true, data: { data: [{ requirement_id: 5846, task_id: 22610, task_project_id: 212, task_status: 'in_progress', link_role: 'implementation' }], total: 1 } }
    const r = { id: 5846, display_id: 'REQ-20260930-0005', project_id: 212, status: 'approved' }
    return String(url).includes('?') ? { success: true, data: { data: [r], total: 1 } } : { success: true, data: r }
  }
  await assert.rejects(checkPullRequest(options), /changed/)
  assert.equal(f.calls.length, 0)
})

test('HTTP failures never expose response content or provider errors', async () => {
  const secret = 'private-canary-token'
  for (const fetchImpl of [
    async () => new Response(secret, { status: 401 }),
    async () => { throw new Error(secret) },
    async () => new Response(secret),
  ]) {
    await assert.rejects(readJson('https://ai.pipexerp.com/api/v1/requirements', secret, fetchImpl), error => !error.message.includes(secret))
  }
})

test('HTTP adapter rejects oversized responses and missing credentials before any request', async () => {
  await assert.rejects(readJson('https://ai.pipexerp.com', 'token', async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /byte limit/)
  let called = false
  await assert.rejects(readJson('https://ai.pipexerp.com', '', async () => { called = true }), /credential/)
  assert.equal(called, false)
})

test('HTTP adapter confines credentials to a bounded nonredirecting request', async () => {
  await readJson('https://ai.pipexerp.com/api/v1/requirements', 'token', async (url, options) => {
    assert.equal(url, 'https://ai.pipexerp.com/api/v1/requirements')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer token')
    assert.ok(options.signal instanceof AbortSignal)
    return new Response('{}')
  })
})

test('a missing CI credential publishes failure for the exact event head', async () => {
  const statuses = []
  await assert.rejects(runPolicyEvent({
    event: { pull_request: { number: 40, head: { sha: head } } }, repository,
    githubToken: 'github', projectToken: '',
    fetchJson: async () => { throw new Error('must not fetch') },
    writeStatus: async data => statuses.push(data),
  }), /credential/)
  assert.deepEqual(statuses.map(s => [s.head, s.context, s.state]), [
    [head, 'Issue policy', 'pending'], [head, 'Issue lifecycle', 'pending'],
    [head, 'Issue policy', 'failure'], [head, 'Issue lifecycle', 'failure'],
  ])
})

test('an unsupported repository never publishes a status or uses credentials', async () => {
  await assert.rejects(runPolicyEvent({
    event: { pull_request: { number: 40, head: { sha: head } } }, repository: 'other/repo',
    writeStatus: async () => assert.fail('must not write'), fetchJson: async () => assert.fail('must not fetch'),
  }), /repository/)
})

test('successful checks publish both governance statuses only after validation', async () => {
  const statuses = []
  const f = fixture()
  const result = await runPolicyEvent({
    event: { inputs: { pull_request_number: '40' } }, repository,
    githubToken: 'github', projectToken: 'project', fetchJson: f.fetchJson,
    writeStatus: async data => statuses.push(data),
  })
  assert.equal(result.head, head)
  assert.deepEqual(statuses.map(s => [s.head, s.context, s.state]), [
    [head, 'Issue policy', 'pending'], [head, 'Issue lifecycle', 'pending'],
    [head, 'Issue policy', 'success'], [head, 'Issue lifecycle', 'success'],
  ])
})

test('dispatch rejects noncanonical PR numbers before status writes', async () => {
  await assert.rejects(runPolicyEvent({
    event: { inputs: { pull_request_number: '040' } }, repository,
    writeStatus: async () => assert.fail('must not write'), fetchJson: async () => assert.fail('must not fetch'),
  }), /dispatch PR number/)
})
