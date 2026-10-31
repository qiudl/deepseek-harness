# Step2 orchestration report

English | [中文](step2-orchestration-report.zh.md)

## Outcome

Host creation, client forwarding and the Agent-owned model-selection implementation are integrated. Completion remains blocked on Python SDK runtime validation and on the original upstream tag merge: `dsh-v0.2.2-alpha.2` is not an ancestor of this branch. The worktrees retain their commits and no branch was pushed.

## Subtasks

| Task | Integrated commits | Evidence and limits |
| --- | --- | --- |
| Host | `e5d2c5d453`, `fcccf91419`, `d75a39d580` | Exact adoption and new-conversation claims share an identity queue; partial workspace attachment is reported; the later barrier regression covers concurrent preset capture. Host-owned control and startup packages remain present. |
| Client | `309807e2fb`, `2c8ad5523d` | The client forwards `agentPreset`, `exactAdopt` and `dedicatedCollaboration`, uses the returned identity and distinguishes an already-attached Session after partial failure. |
| Model | `6f3b036c7f`, `a9e92e80eb`, `a1d148acbb`, `d0e958172d`, `d392b21316`, `c70a706d4e`, `62fea1c7e6` | Projection v3 has one Agent model-selection writer; ACP turn pinning, headless, Session cold inspection and v2 cache reconstruction were adapted. Persisted schema acknowledgement passed. |
| Integration | Merge commits on this branch; `69ba5e2430` refreshes the merged persistence catalog | Host/client and model conflicts were resolved together; the `claims` identity queue remains, the old selection WeakMap was removed, and bilingual records were regenerated. |

## Validation

The final integrated focused Vitest run passed 235 tests across eight files covering Session creation, model selection, client manager, Host control, Agent and ACP. The Session controller Host TypeScript build, `verify-no-unknown-casts`, `verify-persistence-changes`, `verify-persistence-catalog`, `verify-cordis-catalog`, `verify-export-jsdoc` and `verify-upgrade-guides` passed. The model branch also passed its full Host reference build and the targeted ACP/headless regressions.

After building the local native addon and generating the required ignored Typert Host artifacts, the TypeScript SDK `multi-turn` and the `model-switch-notice` recorded-session snapshots each passed. Earlier attempts without those artifacts failed; the successful reruns use the integrated source and rebuilt local artifacts.

Python SDK behavior and packaged-runtime snapshots were not run. Offline `uv sync --locked --group test` could not find the `pydantic-core 2.46.5` macOS arm64 wheel in the local cache, and the current packaged runtime executable is absent. Python AST parsing is not a substitute for those tests. Windows packaged validation and Linux subprocess runtime validation remain platform-owned checks.

## Remaining work

Obtain the exact locked Python dependencies and build the current packaged runtime using an authorized environment, then run the Python SDK and expected-output scenarios. Complete the upstream tag merge and its remaining package, build, documentation and version-policy conflicts as separately reviewed work; do not infer that selectively integrated commits contain all 3,166 upstream-only commits. Re-run affected checks on the final merged tree and retain released Session generations without promising downgrade support.

Execution evidence and per-task logs are under `~/coding/logs/step2-orch-*.log`; the SDK diagnosis and offline dependency error are recorded separately in `step2-orch-sdk-validation.log` and `step2-orch-python-offline.log`.
