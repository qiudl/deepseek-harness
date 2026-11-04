# Step2 Phase 2：Session 联合迁移设计

[English](step2-phase2-session-migration-design.md) | 中文

提交标签对应的精确标识保存在 `~/coding/logs/step2-commit-identifiers.md`。

## 摘要

本设计拟将 fork 提交 `fork-baseline` 与上游 `dsh-v0.2.2-alpha.2`（`upstream-tag-commit`）整合。这是待评审方案，并不代表兼容性已经实现。实现须保留 fork 的 Host 权限及协作行为，同时接入上游由 Agent 持有的模型选择和 Session 创建变更。

## 现有语义与调用链

以下 fork 路径与行号对应 `fork-baseline`；上游路径与行号对应 `dsh-v0.2.2-alpha.2` 标签，不代表未来合并后的行号。

fork 创建链：`packages/api/session-controller/src/commands.ts:108` 校验位置，要求专用协作指定工作区，选择身份后调用 `agent.ts:240` 的 `ensureSession`。后者对同一身份共享进行中的创建，拒绝子代理所有权、预设或 cwd 不匹配，并返回该身份。命令先附加工作区，再标记专用协作（`commands.ts:137`、`:148`）；附加失败会报告已经创建的身份。

fork 模型选择：`commands.ts:161` 校验并规范化选择，随后由 `agent.ts:337` 追加 `model/selection` 并缓存。`model-selection-projection.ts:35` 折叠待用选择和 `request/header`，仅在 provider、model、effort 全部匹配时清除待用值；`:95` 回退至最近请求头或 Host 默认值。`index.ts:387` 消费活动缓存，`:453` 可不附加 Agent 而读取协作工作区的选择。

上游创建链：`packages/api/session-controller/src/commands.ts:103` 调用 `agent.ts:239` 的 `createSession`，再附加并返回 `created.agent.id`。`agent.ts:331` 串行处理指定身份的 claim；`:343` 校验所有权和 cwd，检查冷状态与位置，仅复用符合条件的空白 Session，对已开始、不可用或不符合复用条件的 Session 新建身份。`:393` 为可复用的活动 Agent 应用选定预设。

上游模型选择：`packages/api/session-controller/src/commands.ts:149` 校验后调用 `agent.model.select`。`packages/core/agent/src/model-selection.ts:72` 拥有版本 3 投影并折叠相同事件类型；`:58` 从记录的选择中排除 adapter 默认 effort，`:112` 避免追加相同的已记录选择。fork 投影为版本 2，其请求头折叠包含解析后的 effort；删除 fork 文件前须通过重放测试确认差异。

客户端契约不同：fork `packages/api/session-controller/src/client/contract/sessions.ts:104` 接受 `dedicatedCollaboration`；上游 `:88` 接受 `agentPreset`，并说明返回身份可能不同于请求的空白 Session。所有调用者都须使用返回身份，包括工作区附加、专用标记和导航。

## 联合迁移方案

以上游创建流程和 Agent 模型所有权为实现基础，迁入 fork 的协作字段、日志、授权和工作区检查。只注册一个 `modelSelection` 投影并保留一个持久选择写入者。协作检查应适配上游投影或导出的纯折叠函数；在证明冷读取、缓存重建、显示和重放行为等价前，不删除 fork 投影。不得在相同 key 下同时注册版本 2 和版本 3。

对新会话采用上游仅复用空白 Session 和指定身份串行 claim 的机制。对要求精确身份的调用方，提供明确的精确采用操作或模式，保留 fork 的 cwd、预设和子代理检查；该操作不得静默生成其他身份。改变行为前须确定哪些现有调用方需要精确采用。工作区附加或专用标记失败时必须公开已创建身份与真实部分结果，不得声称已回滚。

客户端类型与 Host wire schema 同步迁移：保留 `dedicatedCollaboration`、增加 `agentPreset`、保留响应身份，并在同一变更更新所有消费者。只有混合版本部署确有书面要求时才使用短期显式适配器；否则不公开两套并行 API。专用创建必须针对实际返回身份验证成员关系及授权，完成附加后才标记。

保留 fork 的选择保证：成功返回前已持久记录经过校验的选择；待用选择重启后仍在；匹配请求消费它，不匹配请求不消费；冷读取不产生写入；默认值保存失败可观察但不撤销 Session 选择。使用记录事件比较 fork 规范化与上游 `AgentModel.select` 及 adapter 默认 effort 的差异，再确定唯一规则并原子更新投影、调用方和快照。

## Host 控制与启动

完整保留 fork 拥有的 `packages/host/control-protocol` 和 `packages/host/desktop-host`，包括类型化请求、认证、签名、票据归属、传输失败区分、worker 关闭、启动组合及 Windows 专属路径。`packages/host/desktop-host/package.json:21` 和 `tsdown.config.ts:104` 导出并构建独立控制客户端；`src/startup.ts:311` 提供可执行文件摘要检查。上游不存在这些 fork 文件并不意味着可以删除。

验证构建后的客户端导出与产物加载、wire 往返及无效签名、对端和账户授权、Bot 与协作范围、worker 退出、启动失败清理以及 Unix 和 Windows 路径。使用现有客户端产物、控制协议和启动测试，并为变更的集成点补充针对性回归。实际 Windows 打包验证仍是平台专属验收项。

## 持久化与兼容性

两个版本均声明 Session JSONL 格式 4（fork 的 `packages/core/session/src/types.ts:89`，上游的 `:90`）。版本相同不能证明双向兼容：`packages/session/session-persistence/src/storage-contract.ts:75` 拒绝未知必需事件，上游 `packages/core/session/src/known-event-types.ts:45` 新增 `job/registered` 和 `job/settled`。不得仅为通过旧读取器而将必需事件标为 ignorable；不承诺降级。

重放有代表性的已发布 fork 与上游 JSONL 日志，覆盖待用选择、显式和默认 effort、中断请求、jobs 和协作。评审声明的持久类型变更与读取准入；保留已提交历史代际，确有需要时仅使用相邻后继迁移。依据不安全解释的证据决定格式版本，而不是仅比较版本数字。验证投影 v2 到 v3 的缓存失效与冷重建，不把缓存当作权威数据。

双方均声明 Session 查询 SQLite schema 8 和存储 SQLite schema 1（`packages/session-query/session-query-sqlite/src/schema.ts:8`；`packages/storage/storage-sqlite/src/schema.ts:20`）。查询 schema 是派生索引；存储具有独立准入规则。比较实际 schema 与类型变化，使用副本测试升级，并在需要时重建派生索引。任何 SQLite schema 变更都须使用递增版本；不能因为数字相同就推断兼容。

## 分步实施与验证

1. 清点精确身份调用方、wire 消费者、持久事件 schema 和 Host 包导出，收集已发布日志与 SQLite fixtures。实施前评审身份策略。本步仅涉及文档和 fixtures；放弃时可回退对应提交。

2. 整合单一模型投影、Agent 选择所有者及协作冷读取；运行选择、投影、缓存、取消和重启针对性测试以及所需 Session 和 SDK 快照。保留可单独回退的提交；兼容评审确认必要之前不改变 Session 格式。

3. 在一个原子提交中整合创建、精确采用及全部客户端/wire 消费者。测试并发 claim、活动与冷 Session、已开始或 writer 占用的身份、cwd/预设/子代理拒绝、返回身份、专用标记和工作区附加失败。客户端与 Host 联合检查失败时整体回退该提交。

4. 将 Host 包与子进程隔离分别整合为可单独回退的包组提交。运行协议、启动、构建产物和生命周期测试，并验证子进程发布文件允许列表及 Linux scope 行为。由对应 CI 或主机执行实际平台检查。

5. 完整合并后运行针对性的 Session、Host、子进程和客户端检查、两个 SDK 的预期输出、相关快照及持久化门禁。实际迁移前备份用户数据；回退代码不等于数据降级，已发布后继不得覆盖或删除。

## 风险与待人工决定

- 确定现有指定身份的 `session.create` 调用方是否要求精确幂等采用，还是接受上游仅复用空白 Session 并返回新身份；逐一识别调用方与外部兼容义务。

- 确定持久和展示选择应采用规范化后的 adapter 默认 effort，还是上游仅记录显式 effort；评估缓存状态版本 2 到 3 及混合历史日志。

- 确定是否支持混合版本 Host 与客户端运行；如支持，定义适配器寿命和发布顺序。确认工作区附加成功但专用标记失败时的恢复责任。

- 比较 schema 并重放后，确定事件或持久类型变更是否需要 Session 后继代际或 SQLite schema 递增。明确 Windows 打包测试和真实 fork 数据 fixtures 的负责人。

- 明确协作日志生命周期、取消和工作区权限如何与新生成身份交互；失败不得静默重新绑定现有数据。在测试与维护者确认前保留这些待决事项。
