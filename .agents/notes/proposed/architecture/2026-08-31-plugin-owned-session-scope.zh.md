# Agent Note：插件拥有的持久 Session Scope

状态：提议

[English](2026-08-31-plugin-owned-session-scope.md) | 中文

## 问题

部署插件可能需要一个持久身份，用于决定 Session 能否执行以及如何组合其 Agent。只把该身份保存在进程内会在恢复时丢失；把某个产品的账号、租户或员工词汇加入核心，则会破坏插件架构，也会阻碍其他 Provider 使用同一机制。

## 方案

`SessionHeader.scope` 是可选的不可变 `{ provider, ref, schemaVersion }`。`provider` 命名插件拥有的命名空间，`ref` 对核心不透明，`schemaVersion` 允许该 Provider 拒绝不兼容引用。Session 创建时快照并校验该记录，JSONL 与 SQLite 都会保真，fork 会精确继承。

`AgentRegistry.registerScopeProvider()` 是扩展接缝。agent-loop 在未发布的创建事务内、调用方 setup、注册表进入、公告和驱动器启动之前，请求精确匹配的已注册 Provider 准入带 scope 的 Session。Provider 会收到未发布的 `agentCtx`，因此其作用域组合由该事务拥有并随失败回滚。Provider 缺失或拒绝时失败关闭。如果异步准入期间 Provider 被卸载，注册表对精确实例的再次校验会拒绝发布。取消会与准入竞争，但不会发布候选 Agent 或 Session。

核心只拥有持久传输、Provider 注册、生命周期顺序与失败关闭。Provider 插件拥有引用解释、授权、远程调用、作用域工具/提示词组合以及兼容策略。方案不引入环境式“当前账号”或 Host 全局可变身份。

SQLite 的 Session 元数据按列存储，因此物理 schema 从 19 提升为 20，避免旧二进制静默丢弃新字段。事件行 codec 与 Session 日志格式不变；预发布 `SESSION_FORMAT_VERSION` 仍保持 0。

## 验收标准

- Scope 元数据是无损 JSON，创建后不可变，由 JSONL 和 SQLite 保真，并由 fork 继承。
- 非法 provider/ref/version 形状在 Session header 边界失败。
- 每个 provider id 只能由一个 Provider 拥有，注册随 effect 生命周期撤销。
- 新建与恢复都在 setup 和发布之前执行 scope 准入。
- Provider 缺失、拒绝、取消或并发卸载时，不留下 live Agent 或 Session。
- 核心源码不包含 Provider 专属业务词汇、端点、凭据或环境式可变身份。

## 风险

准入可能执行远程工作，因此 Provider 必须遵守传入 signal，并让检查具备幂等性。核心会竞争取消，但无法停止忽略 signal 的 Provider；它只能阻止迟到结果发布。因此 Provider 的 `ref` 必须不是秘密，并且适合持久化。跨 scope fork 刻意不属于核心操作：继承的 scope 固定不变，需要不同 scope 的产品必须通过其 Provider 拥有的流程创建新 Session。
