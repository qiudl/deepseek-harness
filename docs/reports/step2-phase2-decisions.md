# Step2 Phase 2: recommended decisions

English | [中文](step2-phase2-decisions.zh.md)

These recommendations are pending human review. The user authorized implementation along them; each implementation still needs its stated tests. References name fork `727d4318` or upstream tag `dsh-v0.2.2-alpha.2`, as indicated.

## 1. Named Session identity

Recommendation: preserve exact identity for existing fork callers; expose upstream blank-only reuse as an explicitly distinguished new-conversation path. Fork `packages/api/session-controller/src/commands.ts:115` and `agent.ts:240` adopt a named identity; upstream `agent.ts:343` can mint another. Exact adoption protects existing workspace and collaboration references. Impact: Host command, client contract and all call sites; test concurrent, started, writer-held and cwd/preset/owner cases. Rollback cost: revert the atomic Host/client change; already-created Sessions remain durable and require explicit recovery.

## 2. Model effort and projection

Recommendation: use upstream Agent-owned projection v3 and explicit-only adapter-default effort; preserve fork pending choice, cold inspection and validated selection, with a single writer. Upstream `packages/core/agent/src/model-selection.ts:58` and `:72` omit adapter defaults; fork `packages/api/session-controller/src/model-selection-projection.ts:35` folds resolved effort. This preserves the distinction between user intent and provider defaults. Impact: projection, display, cache and snapshots; replay historical explicit/defaulted events and test v2 cache invalidation. Rollback cost: revert the code and rebuild disposable caches; durable events cannot be rewritten or assumed downgrade-safe.

## 3. Client rollout and partial creation

Recommendation: update Host and all typed clients atomically; do not promise mixed-version operation without an explicit deployment requirement. Retain both `dedicatedCollaboration` and `agentPreset`, use the returned identity, and report the created identity if workspace attachment or dedicated marking fails. Fork `packages/api/session-controller/src/commands.ts:137` attaches before marking at `:148`; upstream `commands.ts:129` takes the returned identity. Impact: RPC schema, consumers and recovery UX. Rollback cost: revert the coordinated commit; partially attached Sessions need inspection and explicit repair.

## 4. Persistence versions and acceptance owners

Recommendation: retain Session v4 and SQLite versions only if schema comparison and replay prove safe reader behavior; otherwise use the required adjacent successor or monotonic SQLite increment. Do not mutate released generations or promise downgrade. Fork `packages/core/session/src/types.ts:89`, `packages/session/session-persistence/src/storage-contract.ts:75`, and SQLite `packages/session-query/session-query-sqlite/src/schema.ts:8` show the existing checks; upstream adds job events. The Session/persistence maintainer owns fixture and type review; the Windows Host maintainer owns packaged Windows validation. Impact: event readers, projection caches, SDK and storage. Rollback cost: code can revert, but migrated data requires backups and an explicitly supported recovery path.

## 5. Collaboration ownership and cancellation

Recommendation: bind journals and authorization to the actual returned Session identity after workspace membership is checked; never transfer an existing journal to a minted identity implicitly. Propagate cancellation and retain existing cleanup ownership. Fork `packages/api/session-controller/src/index.ts:235` owns lifetime and `:327` checks workspace collaboration; `commands.ts:137` attaches before the dedicated mark. Impact: workspace, Host control and client routing; test membership changes, cancellation, teardown and partial failures. Rollback cost: revert the integration commit; inspect any durable journals and do not silently rebind them.
