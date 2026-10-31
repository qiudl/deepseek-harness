---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-upstream-fork-merge

English | [中文](2026-10-31-upstream-fork-merge.zh.md)

## Summary

Joins fork and upstream Session source-attribution histories while retaining both committed records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 2
id: 2026-10-31-upstream-fork-merge
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-10-11-slark-alpha2-integration","2026-10-13-liveshare-share-viewer-principal"]
    after: "b0ad4a8e977a3e967d59ca35314069e94ff05807e9726e56a6a6ebeaeca047f0"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-10-11-slark-alpha2-integration","2026-10-13-liveshare-share-viewer-principal"]
    after: "56027cab6c2e3182151292dee6b17518b8d4a1589454f2d2bcf7045e0f88d59d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-10-11-slark-alpha2-integration","2026-10-13-liveshare-share-viewer-principal"]
    after: "23805f1188f8368d32c592a9324ac45fbd6d79569e25c107f13484fb97878c61"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-10-11-slark-alpha2-integration","2026-10-13-liveshare-share-viewer-principal"]
    after: "aa7eea18a66fdfdcb473313e58fdeb61f4a24be671ed9322d01545e50fe10126"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The current schemas retain collaboration-result attribution alongside the upstream optional principal, skill-catalog metadata, and action-cards attribution. Existing records need none of these additions; older readers preserve unknown source attribution, and absent optional fields retain their existing meanings. The Session format version is unchanged and released generations are retained.

<a id="verification"></a>
## Verification

Each of the four event roots was compared from both parent schemas to the current schema; the classifications contain only optional fields and source-policy attribution additions. The Session controller passed 1,674 tests, the Python SDK passed 251 tests, and the relevant recorded-session snapshots passed.

<a id="dev-note"></a>
## Dev Note

None.
