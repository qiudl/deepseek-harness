# Agent Note: DSH Web profile 的 Slark 本机协作

Status: implemented

[English](2026-08-30-slark-local-collaboration.md) | 中文

## 问题

Slark Desktop 可以从企业工作台切换到个人 DSH 工作台，但临时页面无法代表正式产品边界。正式 DSH Web runtime 运行在用户电脑上并拥有本机模型凭证和算力；Slark 拥有企业成员关系、每个企业与用户唯一的个人项目，以及当前选择的协作上下文。两个应用需要经过认证的同机协议，同时不能把 DSH 变成企业托管 runtime，也不能让 Slark 接管模型 Token。

## 决策

launcher 提供 Slark installation identity、Unix socket 路径和本机 access-key 路径时，Web bundle 条件组合 `@deepseek-ai/dsh-slark-local-collaboration`。普通 `dsh web` 不加载该 row，仍可独立使用。

DSH 进程通过 Slark 的换行分隔本机 discovery 协议注册准确的 loopback Web origin。它使用 HMAC-SHA-256 对 request、进程身份 descriptor、排序后的 capabilities、新 process nonce 和 daemon challenge 证明持有共享密钥。Slark 负责原生 peer process 验证；DSH 只接受匹配的 ACP 初始化和版本化企业上下文 frame。双方确认每次上下文转换后，Desktop 才把它显示为已应用。

已接受的企业、个人项目和环境标识符会成为 DSH 的动态 system context 和可信 `DSH_*` shell 变量。它们不会替换本机 workspace、本机文件系统 provider、模型凭证或算力 provider。企业名称按 JSON 编码，模型文本明确把该记录标记为数据而非指令。断连或 frame 非法时，插件会先清除上下文再重连，避免仅因本机 socket 消失而让已撤销权限继续对模型可见。

Desktop launcher 必须让正式 Web runtime 绑定 `127.0.0.1`，并在生产环境标识专用 DSH 可执行文件。本机开发组合可以信任 Node 可执行文件来验证真实协议，但该值不是生产 installation identity。

同一条认证连接还声明 `token_cost_observability_v1`。Slark 所有的 `llm/stream` interceptor 会追加包含 route、attempt 编号和不可变认证 binding 快照的 `slark/invocation-start`，完成 flush 后才构造下游 stream。coverage 分母使用这个 marker，而不是 `step/start` 或 `request/*`。Provider usage 按每次 dispatch 无正文投影，因此 retry 仍作为独立计费调用。daemon 只有持久接收后才返回 ACK；DSH 追加 `slark/usage-ack`，有界持久 session 扫描会在重连后重放冷 session 中未确认的 revision。wire allowlist 排除 prompt、回答、工具、文件、凭证和 Provider 错误正文。

## 考虑过的替代方案

**保留 Desktop 所有的临时页面。** 拒绝，因为它只能证明导航外壳，不能证明 DSH 启动、session UI、上下文确认或正式 Harness runtime 的使用。

**把 DSH 托管在企业 Slark 服务中。** 拒绝，因为这会把个人模型凭证和算力移入企业基础设施，违反个人电脑工作台边界。

**在 DSH 内直接加载企业 Slark 页面。** 拒绝，因为企业项目导航属于 Slark；这种方案会让个人工作台依赖 Slark renderer 和认证内部实现，而不是 agent 协作协议。

**把企业个人项目视为远程文件系统或 Token 池。** 拒绝，因为该项目是协作权限与路由上下文；本机 DSH 执行仍发生在用户电脑上。

**从 `step/start` 或 request metadata 推断 dispatch。** 拒绝，因为这些事件已经存在后，durability checkpoint 失败仍会阻止 Provider 调用。产品所有的 pre-dispatch marker 与 flush 让 coverage 分母保持真实。

**把 retry 合并成一个 step 总量。** 拒绝，因为 Provider retry 会独立计费。attempt identity 与 retry 边界保留各自证据。

## 验证

包级协议测试通过真实 Unix socket 执行 registration challenge、proof、ACP 初始化、上下文应用、usage 投递和双方 acknowledgement。投影测试固定同 attempt usage last-wins、retry 分离、usage 缺失 coverage、ACK 抑制和零正文 allowlist。交付组合构建包含 opt-in row，普通 Web profile 则保持禁用。本机产品验收启动正式构建的 Web profile，从已安装 Slark Desktop 打开它，在两个企业个人项目上下文之间切换，并返回所选的 Slark 企业页。

## 后果

Slark 与 DSH 在共享一个已认证协作上下文和零正文成本证据的同时，继续保持独立的产品和资源归属。代价是 Desktop、daemon、DSH Web 三个进程的生命周期、必须保持 socket、key、installation identity、可执行文件身份与 loopback origin 一致的 launcher 契约，以及 session 历史中的 append-only acknowledgement 记录。这些值不一致时，Slark 无法使用 DSH，但 DSH 的独立运行不受影响。证据链刻意不执行 prompt 或缓存优化；后者仍是以后由数据门禁决定的独立事项。
