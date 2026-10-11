---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-21-user-question-reply

[English](2026-09-21-user-question-reply.md) | 中文

## 概述

将 user-question-reply 来源归因接入 Slark collaboration-result 的类型历史。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-user-question-reply
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "fca6a6cdab6313eae42e0d8a1533e795a7cbce20cf88858febe0c2bcb73e4346"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "57b8dc41ba4243fbbdfae7d1ad595561d8608a108235229c31409c4120b2bfba"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "de4a9471c9747581aa969d4b6de74ce4f9257fe5d02542f7b096ff884c3a9a08"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "ca818cdfb08e9ce763b9d63783667ee405531595750090dba92c15591645402b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session 格式 4 的记录保持有效。两种来源仅包含归因信息；不认识该来源类型的读取器保留已记录的消息与元数据，不据此授予权限，也不需要依赖写入方回放。在本 fork 集成时，新引入的 user-question-reply 确认记录承接已接受的 Slark collaboration-result 确认记录。已发行的会话代际文件不改写。

<a id="verification"></a>
## 验证

rc.2 集成通过 JSONL 目录迁移、原生来源准入、v3 到 v4 迁移、Host 历史迁移来源测试以及 182 项 YAML 加载的 Slark 输入框回归。历史格式清单验证 v0 到 v4 的完整参考。

<a id="dev-note"></a>
## 开发备注

无。
