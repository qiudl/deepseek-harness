# Agent Note: B2 拆线与升级基线

Status: implemented

[English](2026-09-07-B2-split-line-and-upgrade-baseline.md) | 中文

## Problem

Slark fork 需要 DSH 协议改进，同时避免在上游 Host、core、Session 或 interaction 源码中引入 Slark 专属值。变基冲突容易侵蚀这条边界。

## Decision

可复用的事件游标与截断、Session 重命名/删除/离开、approval v2 幂等结算、协议版本协商和一致性夹具归上游。移动端调用方配置、引擎与环境声明、能力广告、Slark identity/fs/shell 适配器和云端预设保留在 fork overlay。

必需检查 `host-core-slark-sniff` 拒绝 Host、core、Session 和 interaction 源码中的 Slark 专属值。`.dsh-slark-value-domain.json` 是受控值域清单。`drift-probe.yml` 报告上游漂移，`rebase-smoke-report.yml` 按固定上游 SHA 试合 overlay 提交并上传报告。

## Alternatives considered

**把 Slark 专属值放入共享 Host/core：** 拆线表把这些值分配给 fork overlay，必需的 sniff 检查会拒绝它们出现在共享源码中。

## Consequences

fork 将产品专属身份和能力留在共享包之外，通用协议行为则可以在上游复用。升级仍需审查语义冲突：针对固定上游 `d347e703` 的十二个提交探针仅有一个干净试合，另十一个在 Host、控制协议、Session 持久化、agent loop、CLI 和文档等位置发生冲突。
