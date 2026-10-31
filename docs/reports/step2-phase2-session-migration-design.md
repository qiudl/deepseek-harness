# Step2 Phase 2: Session migration design

English | [中文](step2-phase2-session-migration-design.zh.md)

## Summary

This proposed design integrates fork commit `727d4318` with upstream `dsh-v0.2.2-alpha.2` (`f3803c9697`). It is a review artifact, not an implemented compatibility guarantee. The implementation must preserve fork Host authority and collaboration behavior while adopting the upstream Agent-owned model and Session creation changes.

## Evidence and current call paths

Fork references below name files at `727d4318`; upstream references name files at tag `dsh-v0.2.2-alpha.2`. Line numbers refer to those revisions, not a future merge.

Fork creation: `packages/api/session-controller/src/commands.ts:108` validates placement and requires a workspace for dedicated collaboration, chooses an identity, and calls `agent.ts:240` `ensureSession`. The latter shares an in-flight creation for the same identity, rejects subagent ownership, mismatched preset or cwd, and returns that identity. The command attaches it to the workspace before marking dedicated collaboration (`commands.ts:137` and `:148`); attachment failure reports the identity already created.

Fork selection: `commands.ts:161` validates and normalizes a choice before `agent.ts:337` appends `model/selection` and caches it. `model-selection-projection.ts:35` folds pending intent and `request/header`, clearing pending only on a full provider/model/effort match; `:95` falls back to the last header or Host default. `index.ts:387` consumes the live cache and `:453` inspects collaboration workspace selection without necessarily attaching an Agent.

Upstream creation: `packages/api/session-controller/src/commands.ts:103` calls `agent.ts:239` `createSession`, then attaches and returns `created.agent.id`. `agent.ts:331` serializes named claims; `:343` checks ownership and cwd, observes cold state and placement, reuses only eligible blank Sessions, and mints another identity for started, unavailable or otherwise non-reusable Sessions. `:393` applies the chosen preset to a reusable live Agent.

Upstream model selection: `packages/api/session-controller/src/commands.ts:149` validates then invokes `agent.model.select`. `packages/core/agent/src/model-selection.ts:72` owns projection version 3 and folds the same event discriminators; `:58` excludes adapter-defaulted effort from the recorded selection, and `:112` avoids appending an identical recorded selection. The fork projection is version 2 and its header fold includes the resolved effort. These differences require replay tests before removing the fork file.

Client contracts differ: fork `packages/api/session-controller/src/client/contract/sessions.ts:104` accepts `dedicatedCollaboration`; upstream `:88` accepts `agentPreset` and describes a returned identity that may differ from the requested blank Session. All callers must use the returned identity, including for workspace attachment, dedicated marking and navigation.

## Proposed integration

Use upstream creation and Agent model ownership as the implementation base, with fork collaboration fields, journals, authorization and workspace checks carried forward. Keep exactly one registered `modelSelection` projection and one durable selection writer. Adapt collaboration inspection to the upstream projection or an exported pure fold; do not delete the fork projection until equivalent cold inspection, cache rebuild, display and replay behavior are demonstrated. Do not install both version 2 and version 3 under the same key.

For a new conversation, adopt upstream blank-only reuse and serialize named claims. For a caller that requires exact identity, introduce an explicit exact-adoption operation or mode with fork cwd, preset and subagent checks; it must never silently mint another identity. Decide which existing callers need exact adoption before changing their behavior. A failed workspace attachment or dedicated mark must expose the created identity and the actual partial outcome; do not claim rollback.

Migrate the typed client and Host wire schema together: retain `dedicatedCollaboration`, add `agentPreset`, preserve the response identity and update every consumer in the same change. Use a short-lived explicit adapter only if mixed-version deployment is a documented requirement; otherwise do not expose parallel APIs. For dedicated creation, verify membership and authority against the actual returned identity, attach it, and only then mark it.

Preserve fork selection guarantees: a validated selection is durable before success; pending survives restart; a matching request consumes it, a nonmatching request does not; cold inspection is read-only; default-saving failure is observable without undoing the Session selection. Compare fork normalization with upstream `AgentModel.select` and the adapter-default effort difference using recorded events, then select one documented rule and update projections, callers and snapshots atomically.

## Host control and startup

Preserve fork-owned `packages/host/control-protocol` and `packages/host/desktop-host` as complete packages, including typed requests, authentication, signatures, ticket ownership, transport failure distinctions, worker shutdown, startup composition and Windows-specific paths. `packages/host/desktop-host/package.json:21` and `tsdown.config.ts:104` expose and build the standalone control client; `src/startup.ts:311` supplies executable digest checks. Upstream absence of these fork files is not authorization to delete them.

Verify built client exports and artifact loading, wire round trips and invalid signatures, peer and account authorization, Bot and collaboration scope, worker teardown, startup failure cleanup and both Unix and Windows platform paths. Use existing client artifact, control protocol and startup tests; add focused regressions for changed integration points. Actual packaged Windows validation remains a platform-specific acceptance item.

## Persistence and compatibility

Both revisions declare Session JSONL format 4 (`packages/core/session/src/types.ts:89` in fork, `:90` upstream). Equal versions do not prove bidirectional compatibility: `packages/session/session-persistence/src/storage-contract.ts:75` rejects unknown required event types, and upstream `packages/core/session/src/known-event-types.ts:45` adds `job/registered` and `job/settled`. Never mark a required event ignorable merely to pass an old reader; do not promise downgrade.

Replay representative released fork and upstream JSONL logs, including pending selection, explicit and defaulted effort, interrupted requests, jobs and collaboration. Review declared persisted type changes and reader admission; preserve committed historical generations and use adjacent successor migrations only when required. Decide format version from unsafe interpretation evidence, not equal numeric values. Validate projection v2 to v3 cache invalidation and cold reconstruction, without treating cache as the source of truth.

Both revisions declare Session query SQLite schema 8 and storage SQLite schema 1 (`packages/session-query/session-query-sqlite/src/schema.ts:8`; `packages/storage/storage-sqlite/src/schema.ts:20`). The query schema is a derived index; storage has its own admission rules. Compare actual schema and type changes, test upgrade on copies and rebuild derived indexes where required. Any SQLite schema change uses a monotonic version; do not infer compatibility from matching numbers.

## Implementation checkpoints

1. Inventory exact-identity callers, wire consumers, persisted event schemas and Host package exports; capture released log and SQLite fixtures. Review the identity policy before implementation. This checkpoint is documentation and fixtures only; revert its commit if abandoned.

2. Integrate one model projection and Agent selection owner with cold collaboration inspection; run focused selection, projection, cache, cancellation and restart tests plus required Session and SDK snapshots. Keep a separately revertible commit and avoid changing Session format until compatibility review establishes a need.

3. Integrate creation and exact adoption with all client/wire consumers in one atomic commit. Test concurrent claims, live and cold Sessions, started or writer-held identities, cwd/preset/subagent rejection, returned identity, dedicated marking and workspace attachment failures. Revert the entire commit if the combined client and Host checks fail.

4. Integrate Host packages and subprocess containment as independently revertible package-group commits. Run protocol, startup, built artifact and lifecycle tests, and verify the subprocess published-file allowlist and Linux scope behavior. Exercise real platform checks on their owning CI or host.

5. After the complete merge, run focused Session, Host, subprocess and client checks, both SDK expected outputs, applicable snapshots and persistence gates. Back up user data before any real migration; reverting code is not a data downgrade, and a published successor must not be overwritten or deleted.

## Risks and decisions for maintainers

- Decide whether existing named `session.create` callers require exact idempotent adoption or accept upstream blank-only reuse and a new returned identity; identify each caller and external compatibility obligation.

- Decide whether normalized adapter-default effort or upstream explicit-only effort defines the durable and displayed choice; assess cache state version 2 to 3 and mixed historical logs.

- Decide whether mixed-version Host and client operation is supported and, if so, define adapter lifetime and rollout order. Confirm recovery ownership when dedicated marking fails after workspace attachment.

- Determine whether any event or persisted type change requires a Session generation successor or an SQLite schema increment after schema comparison and replay. Identify owners for Windows packaged tests and real fork data fixtures.

- Resolve how collaboration journal lifecycle, cancellation and workspace authority interact with a newly minted identity; failure must not silently rebind existing data. Keep these decisions open until tests and maintainers confirm them.
