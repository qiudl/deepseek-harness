# Step2 orchestration plan

English | [中文](step2-orchestration-plan.zh.md)

Exact commit identifiers for the labels are recorded in `~/coding/logs/step2-commit-identifiers.md`.

The tasks start from `orchestration-start` in separate worktrees and retain all fork changes. Each task commits only validated work and records exact commands and outstanding risks.

## Task graph

1. **Host creation**: integrate upstream new-conversation creation and an explicit `exactAdopt` request for exact identity, preserve collaboration and partial-result errors, regenerate Remote artifacts through the repository build, and test Host lifecycle and conflicts.
2. **Model ownership**: integrate upstream Agent model-selection projection version 3 with one writer, preserve pending selection, cold inspection and validation, and test replay and cache invalidation. This task may modify the Session controller; integration reconciles overlapping changes.
3. **Client contract**: retain `dedicatedCollaboration`, add `agentPreset` and explicit `exactAdopt`, propagate the returned identity through consumers, and test client behavior. The client task implements the agreed request fields against the baseline and integration checks the Host wire schema.
4. **Integration**: merge Host, model and client commits, reconcile shared files and generated catalogs, then run focused Session, client, SDK and persistence checks and write the final report. Complete compatibility and upgrade documentation with the changes they describe.

Host, model and client proceed in parallel; integration depends on all three. No task pushes, publishes or changes package version fields. Lockfile changes must be justified against upstream and documented without unrelated dependency upgrades.
