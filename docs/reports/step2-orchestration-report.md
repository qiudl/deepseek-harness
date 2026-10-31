# Step2 orchestration report

English | [中文](step2-orchestration-report.zh.md)

Exact commit identifiers for the labels are recorded in `~/coding/logs/step2-commit-identifiers.md`.

## Outcome

Host creation, client forwarding and Agent-owned model selection are integrated. The `dsh-v0.2.2-alpha.2` merge is in progress on the local pin branch; its conflicts are resolved, but the merge commit awaits the remaining checks. No branch was pushed.

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

## Pin branch verification

The in-progress merge retains the local Host control client, Host startup and subprocess-local install allowlist. `pnpm run build:artifacts` passed all eight stages, `pnpm run build:check` passed both Host and Client aggregate checks, and `pnpm exec vitest run packages/experimental/webworker-packer/tests/image-loadable.spec.ts` passed 15 tests after rebuilding artifacts.

`pnpm exec vitest run packages/subprocess/subprocess-local/tests/control.spec.ts packages/host/desktop-host/tests/startup.spec.ts packages/host/desktop-host/tests/startup-safety.spec.ts packages/host/desktop-host/tests/startup-composition.spec.ts packages/host/desktop-host/tests/host-control-authority.spec.ts packages/host/desktop-host/tests/host-control-session.spec.ts packages/host/desktop-host/tests/unix-transport-client.spec.ts packages/host/desktop-host/tests/unix-transport-server-faults.spec.ts packages/host/desktop-host/tests/unix-transport-authority-faults.spec.ts` passed 84 tests.

`pnpm exec vitest run packages/host/desktop-host/tests/client-artifact.spec.ts packages/host/desktop-host/tests/startup-platform.spec.ts packages/host/desktop-host/tests/collaboration-worker-process.spec.ts packages/subprocess/subprocess-local/tests` passed 437 tests and skipped 16 platform-dependent tests. The complete unit run was interrupted after failures were found; the focused input and teardown regressions passed after correction. The Slark dictionary now includes 238 reviewed entries each for Japanese, Spanish, French, German, Russian, and Portuguese. `pnpm exec vitest run scripts/locale-dictionary-parity.spec.ts` passed both tests; `node node_modules/typescript/bin/tsc -b packages/client/ui-slark-agent/tsconfig.json --pretty false` passed.

The merged-tree Python SDK test group adds locked `pillow==12.3.0`; its macOS arm64 wheel was fetched into the uv cache. `UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --group test --locked --offline pytest` passed 251 tests and skipped 3. The bundled startup test checks the upstream policy: an unavailable optional plugin emits a warning naming the plugin while initialization succeeds.

`pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-macos-arm64 --skip-build` rebuilt the macOS runtime from the verified local artifacts; package scanning reported unresolved-module warnings. `UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --group test --locked --offline python scripts/smoke-python-runtime.py --scenario <scenario> --exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64` passed `sdk-snapshot`, `sdk-restart`, `sdk-minimal`, `sdk-minimal-in-history` and `sdk-dynamic-tools` without updating snapshots.

`pnpm exec vitest run packages/api/session-controller/tests` passed all 1,674 tests in 72 files on the in-progress merge.

`pnpm exec vitest run packages/client/ui-conversation/tests packages/client/ui-chat/tests packages/client/ui-sidebar/tests packages/client/ui-slark-agent/tests` passed all 2,643 tests in 148 files after updating the quote-draft tests for detached sends.

A direct `classifyPersistenceChange` comparison checked the four shared event roots from `2026-10-11-slark-alpha2-integration` and `2026-10-13-liveshare-share-viewer-principal` against `docs/persistence-schema.json`. Relative to the fork snapshot, it reports the upstream optional principal and skill-catalog fields and the action-cards attribution; relative to upstream, it reports the collaboration-result attribution. None of these classifications requests additional compatibility review. The explicit two-parent acknowledgement `2026-10-31-upstream-fork-merge` preserves both committed records; `pnpm run verify-persistence-changes` passed with 65 roots and 22 records, and the persistence-history test file passed 85 tests.

On the in-progress merge, `pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t multi-turn` and `pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t model-switch-notice` each passed their selected recorded-session case.

After the history reconciliation, `pnpm run doc-sync` passed all 43 checks and `pnpm run lint` passed with one unused-suppression warning in the experimental CoT translation package. The subsequent `pnpm run build:check` passed the Host and Client aggregate checks.

The first complete `pnpm run test` finished with 55,131 passed, 12 failed, 1 expected failure, and 258 skipped. The affected tests passed on focused reruns after fixes, including the release workflow, desktop MCP, persistence, Workspace, hover, and bundled profile checks; The second full run passed 55,142 tests and timed out on one real Git/pnpm test; that test passed separately after raising its timeout from 5 to 30 seconds, and the third full `pnpm run test` passed with 55,143 passed, 1 expected failure, and 258 skipped.

## Remaining work

Create the validated merge commit, then update qiu-slark config, ref and SHA in a separate step.

Execution evidence and per-task logs are under `~/coding/logs/step2-orch-*.log`; the SDK diagnosis and offline dependency error are recorded separately in `step2-orch-sdk-validation.log` and `step2-orch-python-offline.log`.
