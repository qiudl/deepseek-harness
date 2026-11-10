---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-10-paired-task-target-step

[English](2026-11-10-paired-task-target-step.md) | 中文

## 概述

记录获授权原配对步骤使用的 slark-task-target-step 消息来源分支。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-paired-task-target-step
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-31-upstream-fork-merge"
    after: "3a9d05da0fc190af27de1e581e1142f408b6cb32f11baf4c7bd9118540a59d21"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-31-upstream-fork-merge"
    after: "2d8d53345c0af04ee1490e0e759c2aa8092e9681d3c1bddd2a832897c67a6a6d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-31-upstream-fork-merge"
    after: "621c5e49e2aed80c879c44132e2683b2f5c8d8898a52d5c415986603b1967057"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-31-upstream-fork-merge"
    after: "23ae2ad7a832e0b1687f15950bba61bec960a64398349548bb6c93977e871b73"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有事件分支和 Session 头保持不变，新读取器保留全部旧消息。旧读取器保留未知的可合并扩展消息来源 kind 及其 JSON 元数据，仍从中派生相同的普通 user/developer 消息正文；来源元数据不授予执行或恢复权限。配对执行仍须持有当前 worker 私有 capability 和原经过鉴权的 Source 准入。独立 paired_task_targets_v1 domain 拥有自身 intent 与 receipt 记录，不迁移、改写、截断或降级任何旧 Session 代或格式。

<a id="verification"></a>
## 验证

生成对比仅识别 agent/inbox/spliced、developer/message、session/title-llm-request 和 user/message 中的新来源分支。已有冻结的配对 Native 回归通过 64 项测试（/private/tmp/req0006-paired-native-frozen-regression-26754.log），包含实际 Agent、Native 和 JSONL 持久化；该组件测试中的 authority/model 输入仍为受控边界。本确认不宣称设备或整个 Task 已结算。

<a id="dev-note"></a>
## 开发备注

无。
