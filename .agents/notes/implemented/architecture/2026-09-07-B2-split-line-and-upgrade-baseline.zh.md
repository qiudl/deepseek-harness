# Agent Note: B2 能力拆线与升级基线

Status: implemented

[English](2026-09-07-B2-split-line-and-upgrade-baseline.md) | 中文

## 问题

共享宿主代码中的 Slark 专属变更会累积升级冲突。可复现的升级演练需要固定上游输入，并明确通用能力与产品专属 overlay 的边界。

## 决策

REQ-20260907-0016 记录面向 qiu-slark REQ-20260907-0014 的 B2 拆线原则。通用能力通过上游 PR 交付；产品专属能力保留在 fork overlay。记录中的演练基线为 fork master `d85ecaff`（`0.1.2-alpha.1`）对照上游 `d347e703`（`0.1.3-alpha.1`）。CI 接收显式上游 SHA。

| 能力 | 去向 |
|---|---|
| events 游标/截断、session rename/delete/leave、approval v2 settle 幂等、supportedProtocolVersions 协商、conformance 夹具 | 上游 PR；合入后才算完成 |
| mobile caller profile、engine/environment claims、capability 广告、slark identity/fs/shell adapter、cloud preset 开关 | fork overlay：packages/slark*、bundle/slark-cloud、host/slark-identity |
| host/core/session/interaction src 中的 Slark 专属值域 | host-core-slark-sniff；任一命中即失败 |

## 检查与探针

- [host-core-slark-sniff.mjs](../../../../scripts/host-core-slark-sniff.mjs) 与 [host-core-gate.yml](../../../../.github/workflows/host-core-gate.yml) 生成 `host-core-slark-sniff` 检查；分支保护决定该检查是否必需。
- [.dsh-slark-value-domain.json](../../../../.dsh-slark-value-domain.json) 定义受控值域清单，记录中的基线为空。
- [drift-probe.yml](../../../../.github/workflows/drift-probe.yml) 每周及手动触发运行；启用失败选项时，`total >= 50` 可导致失败。
- [rebase-smoke-report.yml](../../../../.github/workflows/rebase-smoke-report.yml) 对指定上游 SHA 逐条试合 12 个 overlay 内容提交，并上传报告 artifact。该仅报告探针不能证明完整升级通过。

## 考虑过的替代方案

**移动上游引用。** PRD v2 评审采用冻结 SHA，替代移动引用，使其他环境能够复现演练输入。

**仅按文本扫描。** PRD v2 评审采用受控 issuer/scope/clientId 值域，替代产品名文本匹配，避免漏报运行时分支及误报文档。

**检查关闭开关。** PRD v1 风险讨论提出关闭选项；v2 拒绝该选项，改用具备独立审批和审计记录的书面豁免。

## 影响

通用能力的交付依赖上游合入。产品专属 overlay 保留各自的升级工作。检查与报告 artifact 维持拆线边界并揭示冲突；它们不能证明完整升级演练或产品基线切换已完成。

## 验证证据

记录中的 2026-09-07 本地演练以 `d347e703` 为输入，逐条隔离试合结果为 1/12 无冲突、11/12 冲突。冲突集中于 host/desktop-host、control-protocol、session-persistence-jsonl、core/session、core/agent-loop、apps/cli 和 docs i18n；主要分类为语义适配（类 2）。原记录将 REQ-20260907-0016 标记为 approved/dev，并将完整 D1 报告归于该需求第 4 节。

上述替代方案记录于 ai-proj 项目 212 的 REQ-20260907-0016，PRD 任务 21247，文档 11981（v1 风险讨论及 v2 的冻结输入、扫描边界、拒绝关闭开关决策）。
