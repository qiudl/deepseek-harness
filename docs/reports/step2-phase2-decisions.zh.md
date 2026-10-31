# Step2 Phase 2：决策建议

[English](step2-phase2-decisions.md) | 中文

以下建议均待人工复核。用户已授权按建议实施；各实现仍须完成所列测试。证据分别指向 fork `727d4318` 或上游标签 `dsh-v0.2.2-alpha.2`。

## 1. 指定 Session 身份

推荐：现有 fork 调用方保持精确身份；上游仅复用空白 Session 的行为作为明确区分的新会话路径。fork 的 `packages/api/session-controller/src/commands.ts:115` 和 `agent.ts:240` 采用指定身份；上游 `agent.ts:343` 可能生成新身份。精确采用可保护现有工作区和协作引用。影响 Host 命令、客户端契约及全部调用方；须测试并发、已开始、writer 占用及 cwd/预设/所有权场景。回退成本：整体回退 Host/客户端原子变更；已经创建的 Session 仍持久存在，须明确恢复。

## 2. 模型 effort 与投影

推荐：使用上游 Agent 持有的 v3 投影，对 adapter 默认 effort 只保留显式选择；保留 fork 的待用选择、冷读取及校验，且只有一个写入者。上游 `packages/core/agent/src/model-selection.ts:58` 和 `:72` 排除 adapter 默认值；fork `packages/api/session-controller/src/model-selection-projection.ts:35` 折叠解析后的 effort。这样可区分用户意图和 provider 默认值。影响投影、展示、缓存和快照；须重放历史显式/默认事件并测试 v2 缓存失效。回退成本：回退代码并重建可丢弃缓存；持久事件不能改写，也不能假定可降级。

## 3. 客户端发布与部分创建

推荐：Host 与所有类型化客户端原子更新；没有明确部署要求时不承诺混合版本运行。保留 `dedicatedCollaboration` 和 `agentPreset`，使用返回身份，工作区附加或专用标记失败时报告已创建身份。fork `packages/api/session-controller/src/commands.ts:137` 在 `:148` 标记前先附加；上游 `commands.ts:129` 使用返回身份。影响 RPC schema、消费者和恢复体验。回退成本：回退协调提交；部分附加的 Session 须检查并明确修复。

## 4. 持久化版本与验收负责人

推荐：仅在 schema 对比及重放证明读取安全时保留 Session v4 和现有 SQLite 版本；否则使用要求的相邻后继或递增 SQLite 版本。不得改写已发布代际，也不承诺降级。fork `packages/core/session/src/types.ts:89`、`packages/session/session-persistence/src/storage-contract.ts:75` 和 SQLite `packages/session-query/session-query-sqlite/src/schema.ts:8` 展示现有检查；上游新增 job 事件。Session/持久化维护者负责 fixtures 与类型评审，Windows Host 维护者负责打包验证。影响事件读取器、投影缓存、SDK 和存储。回退成本：代码可回退，迁移后的数据须依靠备份与明确支持的恢复路径。

## 5. 协作所有权与取消

推荐：验证工作区成员关系后，将日志与授权绑定到实际返回的 Session 身份；不得将现有日志隐式转移到新身份。传播取消并保留现有清理责任。fork `packages/api/session-controller/src/index.ts:235` 持有生命周期，`:327` 检查工作区协作；`commands.ts:137` 在专用标记前执行附加。影响工作区、Host 控制和客户端路由；须测试成员关系变化、取消、销毁和部分失败。回退成本：回退集成提交；检查所有持久日志，不得静默重绑。
