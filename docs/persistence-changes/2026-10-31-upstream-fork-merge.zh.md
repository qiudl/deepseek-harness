---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-upstream-fork-merge

[English](2026-10-31-upstream-fork-merge.md) | 中文

## 概述

合流 fork 与上游 Session 来源归因历史，保留双方已提交记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

当前 schema 同时保留 collaboration-result 归因和上游的可选 principal、skill-catalog 元数据与 action-cards 归因。旧记录无需这些新增项；旧读取方保留未知来源归因，缺失的可选字段保持原有含义。Session 格式版本不变，不重写已发布代际。

<a id="verification"></a>
## 验证

逐一比较四个事件根的两个父 schema 与当前 schema；分类结果仅包含可选字段及符合来源策略的 attribution 增加。会话控制器 1674 项测试、Python SDK 251 项测试及相关录制会话快照通过。

<a id="dev-note"></a>
## 开发备注

None.
