# Agent Note: 有界冷 Session 检查

Status: proposed

[English](2026-11-16-bounded-cold-session-inspection.md) | 中文

## 问题

`SessionPersistence.stat().sizeBytes` 衡量的是压缩后的物理存储量，而普通冷读会加载并解码整个 Session。因此很小的 zstd 文件也可能需要远超物理大小预检允许的内存。来源还可能在预检与无界读取之间变化。需要可信完整旧 Session 的消费方，无法通过 `open('read')` 或分页查询自行控制内存预算。

## 提案

持久化 seam 提供可选的 `inspectBounded`，在物理字节、解压字节和事件数上限内读取完整的当前格式日志，并支持取消及预期 revision。JSONL provider 通过同一文件句柄读取，限制每帧 zstd 的输出，校验完整日志，并在返回前复核来源身份。查询 seam 提供 `readColdSessionBounded`，对日志执行回放校验，并在内存中补齐中断的最终回合。超限、历史 generation、记录不完整或来源变化时拒绝，不返回部分结果。不支持此能力的 provider 明确拒绝。

## 考虑过的替代方案

仅依赖 `stat().sizeBytes` 无法限制解压量。现有查询即使分页，也会先完整加载冷日志。让消费方直接读取 JSONL，会在 provider 外重复存储格式与迁移规则。

## 验收标准

测试覆盖原始与 zstd 日志、高压缩比输入、各项预算、过期 revision、历史 generation、取消和回放校验。生成的公开 API 与配对的子系统文档描述此能力。消费方可以通过查询 seam 调用，不必打开存储路径。

## 风险

上限限制输入字节与事件数，但内存中的对象图和分离后的返回值可能占用超过解压流的字节数。调用方应根据进程可用内存选择预算。此 API 拒绝历史 generation，因为尚未证明迁移能在同一预算内完成。
