---
kind: upgrade-guide
description: "现有 Slark Bot 更新须使用声明的包与数据迁移，不能仅替换插件包。"
---

# 现有 Slark Bot 升级

[English](guide.md) | 中文

## 变更

POSIX Desktop Host 拒绝对现有 `ds-bot` Profile 仅更新包，包括 npm 和 GitHub 来源。嵌入应用必须在 `catalog.v1.json` 旁通过 `profile-upgrades.v1.json` 声明精确目标与历史归档摘要。未声明版本、自定义 Bot Home，以及会移除或改变现有数据的转换均不可用。空 Bot Home 的全新安装仍受支持。

升级保留原 Bot 数据和已提交的 JSONL 代际。新版 worker 一旦可能写入，恢复流程就在新数据上继续原操作，绝不会用旧快照覆盖新消息。仅降级受管数据对应的包会阻止 worker 启动。明确卸载插件会保留数据。

## 迁移

1. 安装同时提供验证过的目标归档及已评审 `ds-bot-v1` 策略的 Desktop 构建。在 Slark 打开预期的本地或 Slark Profile，从扩展中心为 DS Bot 选择“升级至随包版本”，核对实际安装与目标版本后确认。已停用、移除或自定义的插件须单独决策，不会自动替换。
2. 若结果待核实，保留原操作 ID，使用 Slark 的“恢复 DS Bot 升级”菜单，通过现有解锁授权重新打开同一 Profile。不要重复更新、编辑 journal 或替换包与数据目录。不支持的数据转换需要经过评审的适配器，不能删除被拒绝的字段。
3. 确认原回执成功、已安装版本与随包目标一致，且新 worker 已确认加载精确版本。在同一 Profile 检查历史、附件、偏好及待处理工作。下载新安装包或旧账本记录均不能单独说明升级完成。
