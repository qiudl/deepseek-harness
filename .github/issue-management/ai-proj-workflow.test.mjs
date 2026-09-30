import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import yaml from 'js-yaml'

const workflow = file => yaml.load(fs.readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'))

test('fork credentials run only in trusted default-branch policy, never PR code', () => {
  const current = workflow('ai-proj-policy.yml')
  assert.deepEqual(Object.keys(current.on).sort(), ['pull_request_target', 'workflow_dispatch'])
  assert.equal(current.jobs.policy.if, "github.repository == 'qiudl/deepseek-harness'")
  assert.deepEqual(current.permissions, { contents: 'read', 'pull-requests': 'read', statuses: 'write' })
  assert.deepEqual(current.concurrency, {
    group: 'fork-ai-proj-${{ github.event.pull_request.number || inputs.pull_request_number }}',
    'cancel-in-progress': false,
  })
  const steps = current.jobs.policy.steps
  const checkout = steps.find(s => s.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}')
  assert.equal(checkout.with['persist-credentials'], false)
  assert.equal(steps.filter(s => s.run).length, 1)
  const gate = steps.find(s => s.run)
  assert.equal(gate.run, 'node .github/issue-management/ai-proj.mjs')
  assert.deepEqual(gate.env, {
    GITHUB_TOKEN: '${{ github.token }}', AI_PROJ_CI_READ_TOKEN: '${{ secrets.AI_PROJ_CI_READ_TOKEN }}',
  })
  assert.ok(!JSON.stringify(steps).includes('pull_request.head'))
  assert.ok(!JSON.stringify(steps).includes('npm'))
})

test('upstream workflows retain their handlers and exclude only the configured fork', () => {
  for (const [file, jobId, command] of [
    ['issue-policy.yml', 'policy', 'pr'], ['issue-lifecycle.yml', 'lifecycle', 'lifecycle'],
  ]) {
    const current = workflow(file)
    assert.equal(current.jobs[jobId].if, "github.repository != 'qiudl/deepseek-harness'")
    assert.ok(current.jobs[jobId].steps.some(s => s.run === `node .github/issue-management/policy.mjs ${command}`))
    assert.ok(current.on.pull_request)
    assert.ok(current.on.pull_request_review)
  }
})

test('the ordinary CI issue-management lane executes the fork validator regressions', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts['test:issue-management'], 'node --test .github/issue-management/*.test.mjs')
})
