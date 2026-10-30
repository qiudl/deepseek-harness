# Agent Note: 按 Profile 限定的 Session 记忆读取

Status: proposed

[English](2026-10-29-profile-scoped-session-memory.md) | 中文

## 问题

独立的记忆 Agent 不会继承 DSH 用户的 Session 权限。Session ID 只能标识日志，不能授权读取内容。把账户全部历史交给 Agent 还会暴露工具载荷和凭据，并消耗远超定向回答所需的上下文。

## 方案

Session 所有权保留在已认证的 Desktop Host 及当前选定的 Person Profile 中。Profile 本地读取器只能枚举该 Profile 的持久 Session 快照，并返回有界、脱敏的用户与助手文本用于索引。Host 在每次读取前后核验当前所有者、Profile、安装和进程代次。每次搜索或证据请求均由短期签名指令授权；worker 只接收投影页并返回候选引用，不接收原始 Session 日志。

当前 master 的 Session 格式是 v0。持久化顶层头包含 `type: "session"`，不含 seed 或 parent 字段。因此投影拒绝带 seed、parent、origin 或非零 delegation depth 的头，拒绝被替换的来源事件。私有读取器应使用已校验的逻辑 `inspect()` 视图，并比较读取前后的 `listSnapshots()` revision。Host 内部模块本身不会开启产品读取。

首个私有路由增量使用 `borrowSession()`，因此拒绝实时 Session，且冷态观察自带持久 revision。只有父 Host 提供独立随机 bearer 时，Web Profile 才暴露精确的 loopback 路由。Host 把该 bearer 保留在 worker 句柄闭包内，并将 reader 固定到该 worker 实例。Host 授权还把当前环境 binding 与 Account 身份解析到同一个由连接解锁的 Profile。已认证的 Unix 传输现在先做这些核验，再建立脱敏索引；只有配置可选的固定公钥环时才公布 `profile.memory_query`。每次搜索或证据读取都验证新的签名指令，包括所有者、计算机、Profile、安装与 Host 代次。控制请求中的所有者和计算机值会与服务端签名匹配；未来的产品适配器在发送请求前，还须把它们绑定到当前 Slark 登录和已入网计算机。

Host 控制协议将 `search` 固定为自身文字索引；只有独立签名的 operation 和已认证的 worker opener 同时存在时，才允许 `semantic_search`。默认启动组合不公布独立的 `profile.memory_semantic_search` capability。worker 可以对脱敏投影排序，但候选引用仍须由当前 Host 核验，才可作为证据来源。

## 考虑过的替代方案

**让记忆 Agent 直接访问 DSH home。** 文件权限会绕开当前 Profile，暴露原始日志、工具结果和无关凭据，并使 Session ID 意外成为访问凭证。

**经 Slark 服务器发送全部 Session 文本。** 这会扩大信任与留存范围，并占用大量提示词上下文。首版把检索和模型留在已入网的 Mac 上。

**让 worker 直接读取 JSONL 路径。** worker 将获得原始文件系统访问权，还须重复实现持久层的实时和恢复语义。Profile 拥有的读取器应使用受支持的持久化操作。

## 验收标准

- 已认证 Profile 可通过签名指令，从自身当前 v0 Session 获取有界、脱敏的片段。
- 切换 Profile、所有者或 Host 代次会使进行中的读取及其索引失效。
- 其他 Profile、过期或重放的指令、伪造的 worker 候选引用均不能获得片段。
- 记忆 worker 不能读取原始 Session 文件；在合成账户通过这些检查前，生产开关保持关闭。

## 风险

原始文本投影要求 JSONL 每行对应一个事件，但 JSONL 持久层默认把连续 chunk 事件打包为存储行。因此直接读取原始产物会拒绝常规产品 Session。Host 另有逻辑事件投影入口，保留相同的 v0、来源和脱敏核验；产品读取器必须使用该入口，在检查前后比较 `listSnapshots()` revision，并拒绝正在变化的来源。脱敏可能遗漏未知形式的凭据，因此在导入真实历史前仍需限制输出并获得用户明确同意。
