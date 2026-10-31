# Step2 orchestration report

English | [中文](step2-orchestration-report.zh.md)

Exact commit identifiers for the labels are recorded in `~/coding/logs/step2-commit-identifiers.md`.

## Outcome

Host creation, client forwarding and the Agent-owned model-selection implementation are integrated. Completion remains blocked on the original upstream tag merge: `dsh-v0.2.2-alpha.2` is not an ancestor of this branch. The worktrees retain their commits and no branch was pushed.

## Subtasks

| Task | Integrated commits | Evidence and limits |
| --- | --- | --- |
| Host | `host-1`, `host-2`, `host-3` | Exact adoption and new-conversation claims share an identity queue; partial workspace attachment is reported; the later barrier regression covers concurrent preset capture. Host-owned control and startup packages remain present. |
| Client | `client-1`, `client-2` | The client forwards `agentPreset`, `exactAdopt` and `dedicatedCollaboration`, uses the returned identity and distinguishes an already-attached Session after partial failure. |
| Model | `model-1`, `model-2`, `model-3`, `model-4`, `model-5`, `model-6`, `model-7` | Projection v3 has one Agent model-selection writer; ACP turn pinning, headless, Session cold inspection and v2 cache reconstruction were adapted. Persisted schema acknowledgement passed. |
| Integration | Merge commits on this branch; `integration-catalog` refreshes the merged persistence catalog | Host/client and model conflicts were resolved together; the `claims` identity queue remains, the old selection WeakMap was removed, and bilingual records were regenerated. |

## Validation

The final integrated focused Vitest run passed 235 tests across eight files covering Session creation, model selection, client manager, Host control, Agent and ACP. The Session controller Host TypeScript build, `verify-no-unknown-casts`, `verify-persistence-changes`, `verify-persistence-catalog`, `verify-cordis-catalog`, `verify-export-jsdoc` and `verify-upgrade-guides` passed. The model branch also passed its full Host reference build and the targeted ACP/headless regressions.

After building the local native addon and generating the required ignored Typert Host artifacts, the TypeScript SDK `multi-turn` and the `model-switch-notice` recorded-session snapshots each passed. Earlier attempts without those artifacts failed; the successful reruns use the integrated source and rebuilt local artifacts.

The macOS arm64 tests used CPython 3.13.13 and the locked `pydantic-core 2.46.5` wheel, whose SHA-256 matches `python/sdk/uv.lock`. The wheel is in `tmp/step2-wheelhouse/`; the default uv cache is `~/.cache/uv` and the test environment is `tmp/py-sdk-venv`. The Python packages require 3.10 or newer, release installation validation uses Python 3.10 as its baseline, and the packaged executable uses Node 24. Offline sync also lacked `pytest 9.1.1`; after fetching missing locked test dependencies, these checks ran:

- `UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --locked --offline pytest`: 212 passed, 10 skipped.
- `pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-macos-arm64 --artifacts-only`: built the native packaged runtime; package scanning emitted missing-module warnings.
- `UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --locked --offline python scripts/smoke-python-runtime.py --scenario <scenario> --exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64`: `sdk-snapshot` (including recovery), `sdk-restart`, `sdk-minimal`, `sdk-minimal-in-history`, and `sdk-dynamic-tools` passed without updating snapshots.

`pnpm run doc-sync` passed all 43 checks after the commit identifiers were recorded in the evidence file above.

`pnpm --filter @deepseek-ai/dsh-subprocess-local pack --dry-run --json` succeeded and listed `lib/runner.js`, `lib/runner-launch-B2zsQ1Dz.js`, and `scripts/ensure-spawn-helper.mjs`; this checks publication selection for the local built artifacts only.

`pnpm exec vitest run packages/subprocess/subprocess-local/tests/linux-scope.spec.ts packages/subprocess/subprocess-local/tests/linux-scope-selector.spec.ts packages/subprocess/subprocess-local/tests/native-containment.spec.ts` on macOS passed 99 tests and skipped 5, including the Linux native-containment suite. Docker could not connect to its daemon and the existing Colima VM reset SSH, so Linux user-systemd runtime validation remains outstanding; Windows packaged validation is deferred.

## Remaining work

Complete the upstream tag merge and its remaining package, build, documentation and version-policy conflicts as separately reviewed work; do not infer that selectively integrated commits contain all 3,166 upstream-only commits. Re-run affected checks on the final merged tree and retain released Session generations without promising downgrade support.

Execution evidence and per-task logs are under `~/coding/logs/step2-orch-*.log`; the SDK diagnosis and offline dependency error are recorded separately in `step2-orch-sdk-validation.log` and `step2-orch-python-offline.log`.
