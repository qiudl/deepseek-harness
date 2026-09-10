# Agent Note: B2 拆线原则与升级基线

Status: implemented

[English](2026-09-07-B2-split-line-and-upgrade-baseline.md) | 中文

## 问题

REQ-20260907-0016 与 Slark REQ-20260907-0014 协同，将可复用 Host 行为与 Slark 专属 overlay 分离，避免上游升级静默改变集成的权威或行为。

## 决策

升级验收使用固定上游 SHA，而非移动引用。通用能力归属上游 PR；Slark 专属身份和环境选择保留在 fork overlay。该策略不证明上游 PR 已合并，也不证明升级已经通过验收。

## 能力归属

| 能力 | 归属 |
|---|---|
| events 游标/截断、session rename/delete/leave、approval v2 settle 幂等、supportedProtocolVersions 协商、conformance fixture | 上游 PR；合并后才算完成 |
| mobile caller profile、engine/environment claims、capability 广告、Slark identity/fs/shell adapter、cloud preset 开关 | fork overlay：packages/slark*、bundle/slark-cloud、host/slark-identity |
| Host core/session/interaction 源码中的 Slark 专属值域 | host-core-slark-sniff 拒绝 |

## 检查与探针

- [Host-core 扫描器](../../../../scripts/host-core-slark-sniff.mjs)及其[工作流](../../../../.github/workflows/host-core-gate.yml)检查[受控值域清单](../../../../.dsh-slark-value-domain.json)。空清单不能证明所有 Slark 专属值均不存在。
- [漂移探针](../../../../.github/workflows/drift-probe.yml)支持周度和手动运行，可选在上游领先 50 个提交时失败。
- [重放探针](../../../../.github/workflows/rebase-smoke-report.yml)生成报告产物。它的存在不构成固定 SHA 验收证据；每次必须核对报告实际选中的 SHA。

## Alternatives considered

**把产品专属值留在上游 Host core。** 这会混合可复用行为与 Slark 权威选择，并增加升级时的语义冲突；拆线策略把这些选择保留在 overlay。

**接受移动上游引用。** 后续解析引用可能选中不同代码，因此验收要求运行实际观测到的精确 SHA。

## 后果

拆线保留可复用的上游目标，但 fork 仍需承担语义适配。原始的 2026-09-07 本地预研记录 fork 基线 d85ecaff（0.1.2-alpha.1）、目标 d347e703（0.1.3-alpha.1），12 次隔离试合中 1 次成功、11 次冲突。记录的冲突集中在 desktop-host、control-protocol、会话持久化、core session/agent-loop、CLI 和双语文档。这些历史观测不是重新运行或当前验收结果；完整 D1 报告仍由 REQ-20260907-0016 第 4 节管理。
