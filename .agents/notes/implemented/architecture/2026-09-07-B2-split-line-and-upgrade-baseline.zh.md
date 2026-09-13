# Agent Note: B2 上游拆线与升级基线

Status: implemented

[English](2026-09-07-B2-split-line-and-upgrade-baseline.md) | 中文

## Problem

REQ-20260907-0016 协同 qiu-slark REQ-20260907-0014，将 Harness 通用协议工作与 Slark 专属 overlay 分开，以独立测量上游升级冲突。原需求记录状态为已批准、开发中；本文记录拆线规则及已入库探针，不表示该需求已经完成。

## Decision

拆线规则按下表分配改动：

| 能力 | 去向 |
|---|---|
| events 游标/截断、session rename/delete/leave、approval v2 settle 幂等、supportedProtocolVersions 协商、conformance 夹具 | 上游 PR；合入上游后才算完成 |
| mobile caller profile、engine/environment claims、capability 广告、Slark identity/fs/shell adapter、cloud preset 开关 | fork overlay：packages/slark*、bundle/slark-cloud、host/slark-identity |
| Host/core/session/interaction 源码中的 Slark 专属值域 | 由必需的 host-core-slark-sniff 规则拒绝 |

原基线记录为 fork master `d85ecaff`（0.1.2-alpha.1），上游为 `d347e703` 前后的 0.1.3-alpha.1 head；其 CI 规则要求使用输入 SHA，禁止移动 ref。这些是历史参照，不是当前运行时固定版本。

## Probes

[Host/core workflow](../../../../.github/workflows/host-core-gate.yml) 运行 [host-core-slark-sniff](../../../../scripts/host-core-slark-sniff.mjs)，使用已入库列表为空的 [.dsh-slark-value-domain.json](../../../../.dsh-slark-value-domain.json)。[漂移探针](../../../../.github/workflows/drift-probe.yml) 每周或手动运行，可在上游领先 50 个提交时失败。[试合报告](../../../../.github/workflows/rebase-smoke-report.yml) 上传仅报告性质的 artifact；当前脚本可回退至 upstream/master，因此 workflow 存在本身不能证明历史的固定输入 SHA 规则已被执行。

## Alternatives considered

**在共享核心放置 Slark 专属值域：**原记录通过 sniff 门禁拒绝这种放置方式，并将这些值域分配至 fork overlay。

**使用移动引用比较基线：**原基线规则拒绝这种方式，要求显式输入 SHA。试合 workflow 的回退仍是限制，不能作为符合规则的证据。

## Consequences

2026-09-07 的本地预研记录在 `d347e703` 上逐条独立试合 12 个内容提交：1 个成功，11 个冲突。冲突集中于 host/desktop-host、control-protocol、session-persistence-jsonl、core/session、core/agent-loop、apps/cli 和文档 i18n。原记录将主要工作归为语义适配（类 2）；全量 D1 报告仍按 REQ-20260907-0016 第 4 节执行。这些结果不能证明当前可合并性或测试状态。
