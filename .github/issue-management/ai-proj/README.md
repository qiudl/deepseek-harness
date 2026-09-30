# Fork ai-proj policy

English | [中文](README.zh.md)

The `qiudl/deepseek-harness` fork validates PRs against approved Requirements in ai-proj project 212. Other repositories retain the existing Issue and Project workflows. Code, coverage, artifact and packaging checks remain independent merge gates.

## References and validation

A PR must cite `REQ-YYYYMMDD-NNNN` and an implementation task, for example `Task 22610`, outside Markdown comments and code. Every cited Requirement must belong to project 212, remain approved, and link a cited implementation task in `in_progress`, `testing` or `completed`. Every cited task must qualify for at least one cited Requirement. Missing, ambiguous, incomplete or unsuccessful API responses reject validation, including for draft PRs.

The validator reads current PR metadata and rechecks its head and references before returning success. The workflow reports `Issue policy` and `Issue lifecycle` commit statuses on the checked head; the lifecycle status audits the same governance records without changing ai-proj approval or GitHub Project data.

## Credential and execution ownership

Configure `AI_PROJ_CI_READ_TOKEN` as a repository secret containing a service credential restricted to read Requirements and their linked tasks in project 212 at `https://ai.pipexerp.com`. Do not use an employee Desktop token. Missing credentials fail validation. Requests have a 20-second deadline and a 2 MiB response limit, reject redirects, and omit response bodies and credentials from error messages.

The workflow uses `pull_request_target` and checks out only the trusted repository default branch with persisted Git credentials disabled. It executes the validator directly under Node without installing or running PR code. Its GitHub token reads PR metadata and writes commit statuses; it does not mutate Issues or Projects. Manual dispatch accepts an open PR number and also uses the default-branch validator.

## Verification and activation

Run `pnpm run test:issue-management` for the existing upstream policy, fork validator and workflow isolation tests. Validate both accepting and rejecting cases in GitHub after the trusted policy is installed and the service secret is configured; local tests do not establish live service access. Historical PR base branches must inherit the policy workflow before their old fork-specific Issue jobs are replaced. Policy changes require review before entering the trusted default branch.

Refs: REQ-20260930-0005, ai-proj Task 22610.
