---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-collaboration-result-attribution

[English](2026-10-06-collaboration-result-attribution.md) | 中文

## 概述

为原 Session 结果反馈增加 collaboration-result 来源归属。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-collaboration-result-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "dcd24094a6f73a5edc7cb775133c10b978f87f6e7d28a40147f7d720b183cc8e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "9ed397f73c7c4d650b6b6a4e270a83185786553e3aa9d2f7624a6d6bf0ec7261"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "e7fd95afbe466d23cb3ecfdc5e69249b3c60bbfc85ebf50b9ce03ada03a31cb0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "ea209d9e44b7740c256303d5b4fa3401ba5ff992087f5c16218ab985b20a244c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有 Session 格式 4 记录保持有效。此来源只表示归属；不认识该 kind 的读取器保留完整日志消息和元数据。它不授予权限，也不要求生产者专用重放。模型检查点独立于来源 kind，适用于关联 Session 的请求。不改写已发布的历史 generation。

<a id="verification"></a>
## 验证

候选真实 Loader/AgentLoop/JSONL 测试通过 80 个独立故障夹具，每份日志均在未加载 SessionController 生产者时重开；反馈与输入框回归共 204 项通过。

<a id="dev-note"></a>
## 开发备注

无。
