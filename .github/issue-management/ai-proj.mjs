/** Read-only ai-proj requirement validation for the Slark DSH fork. */
import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import configuration from './ai-proj.json' with { type: 'json' }

const TASK_STATES = new Set(['in_progress', 'testing', 'completed'])
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * Read explicit references outside Markdown comments and code.
 * @param {string} title Current PR title.
 * @param {string} body Current PR body.
 * @returns {{requirements: string[], tasks: number[]}} Deduplicated governance references.
 */
export function requirementReferences(title, body) {
  const text = `${title}\n${body}`
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/gu, '\n')
    .replace(/`+[^`\n]*`+/gu, '')
  return {
    requirements: [...new Set(text.match(/\bREQ-\d{8}-\d{4}\b/gu) ?? [])],
    tasks: [...new Set([...text.matchAll(/(?:\bTask|任务)\s*#?\s*([1-9]\d*)\b/giu)].map(m => Number(m[1])))],
  }
}

/**
 * Fetch bounded JSON without following redirects or exposing error response bodies.
 * @param {string|URL} url Trusted API address.
 * @param {string} token API-specific credential.
 * @param {typeof fetch} fetchImpl Request implementation.
 * @returns {Promise<object>} Parsed response data; rejects transport and HTTP failures.
 */
export async function readJson(url, token, fetchImpl = fetch) {
  if (!token) throw new Error('Required API credential is missing')
  let response
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
  } catch {
    // Transport errors may include credential-bearing headers; report only the owned failure.
    throw new Error('API transport failed')
  }
  if (!response.ok) throw new Error(`API request failed (HTTP ${response.status})`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('API returned an empty response')
  let bytes = 0
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('API response exceeds the byte limit')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined) // The provider may already have closed the response.
    if (bytes > MAX_RESPONSE_BYTES) throw error
    throw new Error('API response read failed')
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('API returned invalid JSON')
  }
}

function projectData(response) {
  if (response?.success !== true || !response.data || typeof response.data !== 'object') {
    throw new Error('ai-proj API returned an unsuccessful response')
  }
  return response.data
}

function completeList(response) {
  const data = projectData(response)
  if (!Array.isArray(data.data) || !Number.isSafeInteger(data.total) || data.total !== data.data.length) {
    throw new Error('ai-proj API returned an incomplete list')
  }
  return data.data
}

function pullReferences(pull, repository, number, expectedHead) {
  if (pull?.base?.repo?.full_name !== repository || pull.number !== number) throw new Error('PR repository or number differs')
  if (pull.state !== 'open') throw new Error('PR must be open')
  if (pull.head?.sha !== expectedHead) throw new Error('PR head changed')
  if (typeof pull.title !== 'string' || (pull.body !== null && typeof pull.body !== 'string')) throw new Error('PR metadata is invalid')
  return requirementReferences(pull.title, pull.body ?? '')
}

/**
 * Validate a current PR against approved Requirements and cited implementation tasks.
 * @param {object} options Trusted repository configuration, head identity and API credentials.
 * @returns {Promise<{head: string, requirementIds: number[], taskIds: number[]}>} Verified immutable head and linked records.
 */
export async function checkPullRequest({ repository, number, expectedHead, config = configuration, githubToken, projectToken, fetchJson = readJson }) {
  if (repository !== config.repository || repository !== 'qiudl/deepseek-harness') throw new Error('Unsupported repository')
  if (config.projectId !== 212 || config.apiOrigin !== 'https://ai.pipexerp.com') throw new Error('Invalid trusted project configuration')
  if (!githubToken || !projectToken) throw new Error('Required API credential is missing')
  if (!Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{40}$/u.test(expectedHead)) throw new Error('Invalid PR number or head')
  const pullUrl = `https://api.github.com/repos/${repository}/pulls/${number}`
  const refs = pullReferences(await fetchJson(pullUrl, githubToken), repository, number, expectedHead)
  if (refs.requirements.length === 0 || refs.requirements.length > 12) throw new Error('PR must cite 1–12 requirement references')
  if (refs.tasks.length === 0 || refs.tasks.some(id => !Number.isSafeInteger(id))) throw new Error('PR must cite a valid ai-proj task reference')
  const requirementIds = []
  const taskIds = new Set()
  for (const displayId of refs.requirements) {
    const url = new URL('/api/v1/requirements', config.apiOrigin)
    url.search = new URLSearchParams({ project_id: String(config.projectId), search: displayId, page_size: '100' }).toString()
    const matches = completeList(await fetchJson(url, projectToken)).filter(r => r.display_id === displayId)
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw new Error('Requirement lookup is missing or ambiguous')
    const id = matches[0].id
    const requirement = projectData(await fetchJson(new URL(`/api/v1/requirements/${id}`, config.apiOrigin), projectToken))
    if (requirement.id !== id || requirement.display_id !== displayId || requirement.project_id !== config.projectId) throw new Error('Requirement project or identity differs')
    if (requirement.status !== 'approved') throw new Error('Requirement must be approved')
    const links = completeList(await fetchJson(new URL(`/api/v1/requirements/${id}/tasks?page_size=100`, config.apiOrigin), projectToken))
    const implementation = links.filter(link => link.requirement_id === id && link.task_project_id === config.projectId
      && link.link_role === 'implementation' && TASK_STATES.has(link.task_status) && refs.tasks.includes(link.task_id))
    if (implementation.length === 0) throw new Error('Requirement must have a cited, started implementation task in the same project')
    requirementIds.push(id)
    for (const link of implementation) taskIds.add(link.task_id)
  }
  if (refs.tasks.some(id => !taskIds.has(id))) throw new Error('A cited task is not a qualifying linked implementation task')
  const latest = pullReferences(await fetchJson(pullUrl, githubToken), repository, number, expectedHead)
  if (JSON.stringify(latest) !== JSON.stringify(refs)) throw new Error('PR requirement or task references changed during validation')
  return { head: expectedHead, requirementIds, taskIds: [...taskIds] }
}

/**
 * Validate a trusted workflow event and publish its result on the exact PR head.
 * @param {object} options Event data, separate API credentials and status writer.
 * @returns {Promise<object>} Verified Requirement/task identities.
 */
export async function runPolicyEvent({ event, repository, githubToken, projectToken, fetchJson = readJson, writeStatus }) {
  if (repository !== configuration.repository) throw new Error('Unsupported repository')
  if (!event.pull_request && !/^[1-9]\d*$/u.test(event.inputs?.pull_request_number ?? '')) throw new Error('Invalid dispatch PR number')
  const number = event.pull_request?.number ?? Number(event.inputs?.pull_request_number)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid PR number')
  const expectedHead = event.pull_request?.head?.sha
    ?? (await fetchJson(`https://api.github.com/repos/${repository}/pulls/${number}`, githubToken)).head?.sha
  if (!/^[a-f0-9]{40}$/u.test(expectedHead)) throw new Error('Invalid PR head')
  const publish = async state => {
    for (const context of ['Issue policy', 'Issue lifecycle']) {
      await writeStatus({ head: expectedHead, context, state })
    }
  }
  await publish('pending')
  try {
    const result = await checkPullRequest({ repository, number, expectedHead, githubToken, projectToken, fetchJson })
    await publish('success')
    return result
  } catch (error) {
    await publish('failure')
    throw error
  }
}

async function main() {
  const githubToken = process.env.GITHUB_TOKEN
  const result = await runPolicyEvent({
    event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    repository: process.env.GITHUB_REPOSITORY,
    githubToken, projectToken: process.env.AI_PROJ_CI_READ_TOKEN,
    writeStatus: async ({ head, context, state }) => {
      if (!githubToken) throw new Error('Required GitHub credential is missing')
      let response
      try {
        response = await fetch(`https://api.github.com/repos/${configuration.repository}/statuses/${head}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${githubToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context, state, description: 'ai-proj approved Requirement and implementation task validation',
            ...(/^\d+$/u.test(process.env.GITHUB_RUN_ID ?? '') ? {
              target_url: `https://github.com/${configuration.repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
            } : {}),
          }),
        })
      } catch {
        throw new Error('GitHub status transport failed')
      }
      try {
        await response.body?.cancel()
      } catch {
        throw new Error('GitHub status response read failed')
      }
      if (!response.ok) throw new Error(`GitHub status write failed (HTTP ${response.status})`)
    },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
