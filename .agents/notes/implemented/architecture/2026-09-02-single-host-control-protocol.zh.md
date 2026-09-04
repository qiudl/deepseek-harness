# Agent Note：单 Host 本地控制协议

状态：已实现

[English](2026-09-02-single-host-control-protocol.md) | 中文

## 问题

REQ-20260901-0020 要让一台机器上的唯一 DSH Host 同时服务 Slark staging 与生产环境的 Desktop 客户端。仓库现有 SDK JSON-RPC 不适合这个边界：它是 Agent Runtime 的 stdio carrier，会忽略畸形行，也不拥有安装身份。复用它会让安全敏感的本地 supervisor 在歧义输入后继续运行，并把 Desktop 生命周期控制耦合进公开 SDK 面。

Host 与 Broker 在信任任何 profile、environment、session、migration 或 upgrade 命令前，需要独立的第一条消息。它必须协商协议版本、用新鲜 challenge 证明活性、识别安装与当前进程，并准确声明后续可用操作。

## 决策

`@deepseek-ai/dsh-host-control-protocol` 是 Host 组的零 I/O 库，拥有规范 JSON-Lines 信封、64 KiB 对象上限、品牌化跨边界身份、有界错误词汇和版本 1 的 `host.inspect` 交换。畸形输入必须关闭连接。Decoder 要求精确键顺序与形状，随后重新编码规范值并逐字节比较，从而拒绝重复键、数字替代写法、空白变体、CRLF、多行和未知字段。Encoder 也走同一运行时校验，不信任被擦除的 TypeScript 类型。

请求携带新鲜 32 字节 challenge、临时 Desktop client id，以及包含版本 1 的降序去重版本列表。响应选中版本 1，携带互不相同的 Host 进程 id 与持久安装 id、安装级 Ed25519 公钥、正数 runtime/schema generation、持久正数 Host generation、process nonce、包含 `host.inspect` 的排序去重 capability，以及可由 Broker 独立比对的可执行文件签名摘要。单实例 owner 在发布每个 Host 进程前，原子递增 owner-private generation 文件。每个后续授权帧重复该 generation，因此针对旧进程完成的认证无法在重启后授权工作。

挑战签名不是笼统的“签响应 JSON”。`encodeHostInspectSignaturePayload` 构造带域隔离的声明，绑定除签名本身之外的全部请求与响应事实；黄金向量固定非 TypeScript 实现必须使用的精确 UTF-8 字节。响应公钥只用于识别，不能自证可信：Broker 必须将其与可信安装记录匹配，并独立检查对端可执行文件后才接受签名。

后续操作任务扩展已解码载荷联合，不得削弱帧边界，也不得把 transport、authorization、migration 或 Host 进程状态放进本包。

每条 Broker 连接在任何非 Session 操作前 attach 一个权威环境 Session。Host 接受完全相同的 attach 重试，拒绝同一连接切换环境，要求 Session generation 和 permission epoch 单调递增，并要求协议版本 1 与精确 Profile 格式 generation。提升一个环境的 permission epoch，会在其旧连接下次操作前 fence 对应 Session。Detach 必须匹配当前 generation；完全相同的重试返回原始活跃数量，而该 generation 不能再次 attach。连接关闭会移除 Session 并释放 Profile 引用。携带环境的 Profile 操作必须匹配已 attach 的环境。

Desktop 窗口拥有 Session，而不拥有 Host 生命周期。环境切换与应用退出会 detach 当前 Session，并在不发送信号的情况下放弃子进程句柄。更新、移除、migration rollback 或专用安装生命周期可以停止 Host。该分离既避免跨环境进程抖动，也避免 detach 观察到零数量后、另一环境 attach 再遭 SIGTERM 的竞态。

`profile.ensure` 携带由规范 DSH Account 权威为 `dsh-host` audience 签发的短时 ES256 access token。`profile.ensure_account_token` capability 标识这一载荷修订。新客户端拒绝向缺少该 capability 的 Host 发送修订载荷；新 Host 仍解析旧载荷，并在访问 registry 前返回 `upgrade_required`。Host 使用 owner-private 公钥环校验精确 JWT 形状与签名，该公钥环的 SHA-256 摘要由嵌入应用发布版本固定；Host 随后要求已验证的 issuer 与 subject 等于 Desktop 提供的账号字段，才会读取或修改 Profile registry。Host 既不持久化也不记录该 token。

## 缺陷分析迭代

第 1 轮发现四个缺陷：出站值没有运行时校验、base64url 尾部未强制规范、Desktop client id 复用了 Host 身份品牌、版本协商只接受 `[1]`。四项均有聚焦测试。

第 2 轮发现三个协议缺口：签名原文未定义、capability 响应可以缺少基线方法、Host 进程与安装身份可以坍缩为同值。域隔离签名向量、必需基线 capability、安装公钥、正数 generation 和身份分离检查已关闭这些缺口。

第 3 轮没有发现新的包内缺陷。传输缓冲、对端凭证检查、密码学验证、重放状态和操作载荷仍是明确的消费者职责，记录在包限制中，不在这里做半套实现。

第 4 轮发现四个 Account 权威缺陷：token expiry 可以早于 issuance、必填字段静默改变版本 1 wire payload、调用方可以不经过精确 parser 构造 keyring，以及没有直接观测 registry 零 mutation 的负向路径。顺序化时间边界、已签名 capability 标记与旧载荷 `upgrade_required` 响应、强制经过 parser 的 verifier 构造，以及聚焦的零 mutation 覆盖关闭了这些缺陷。

第 5 轮发现两个可靠性缺陷：直接 parser 调用没有 keyring 字节上限，且 bundle patch 会加载 startup subpath，但该 subpath 缺少源码 alias。Parser 现在拥有与 startup 相同的 16 KiB 限制，`tsconfig.base.json` 也将 startup export 映射到源码。第 6 轮没有在 token 校验、密钥固定、滚动兼容、授权顺序、错误映射或凭据留存方面发现新缺陷。

第 7 轮发现四个共享生命周期缺陷：Host 身份缺少重启 fence、连接可以不带环境 Session 执行 Profile 操作、一条连接可以跨环境，以及 Desktop 在观察到陈旧零数量后可能杀掉新 attach 的 Session。持久签名 Host generation、强制连接绑定 Session attach、环境相等检查和安装级停机权关闭了这些缺陷。第 8 轮未在 attach/detach 回放、陈旧 generation 拒绝、断连清理或双环境共存中发现新缺陷。

## Alternatives considered

**复用 SDK JSON-RPC carrier。** 它是会跳过畸形行、且不拥有安装身份的 Agent Runtime stdio 协议，无法执行本地 supervisor 所需的连接级致命认证。

**信任 socket 路径或响应公钥。** 两者都可能被不可信本地进程替换。Broker 改为同时要求注册表中的安装信任与对已连接可执行文件的原生证据。

**让每个 Slark 环境声明 Account 身份。** staging 或 production assertion 会让环境成为 Account 权威，并可能为同一个人创建不同的机器 Profile。两个环境改为向唯一 Host 提交同一个规范 DSH Account 凭据。

**当 detach 返回零活跃 Session 时停止 Host。** 在外部 SIGTERM 前，另一环境可能并发 attach，使该数量变成陈旧值。因此 Desktop 窗口只放弃 Host，停机仍属于安装生命周期操作。

## 后果

协议会拒绝语义等价的 JSON。这减少解析器差异与跨语言歧义，但每个实现都必须遵守已提交黄金向量。未来 peer 仍可用 `[2,1]` 降级协商；版本 1 framing 是兼容 bootstrap。

Profile 创建依赖一个仍可获取有效 Host-audience token 的 DSH Account session。这会阻止离线 environment assertion 创建 Profile，但代价是 Desktop 必须刷新过期的 Account session，才能重试 `profile.ensure`。

所有 Desktop 窗口退出后，Host 仍可继续运行。这会占用一个空闲本地进程，并要求更新／移除工具拥有有界停机流程；同时它能阻止一个环境终止另一环境的工作，并消除基于数量的停机竞态。

Decoder 接收完整字符串，因此能拒绝超限帧，却不能阻止 transport 先缓冲它。Unix domain socket carrier 必须增量执行字节上限，并在首次错误时关闭。没有可信 request id 的无效输入不返回错误帧，只关闭连接。

## 测试

聚焦套件从已提交的 request、result、error 和签名原文向量开始，逐字节 round-trip。负向覆盖未知／缺失字段、空白、多帧、超限、伪造出站值、非规范 base64url、缺失基线 capability、身份复用、未来客户端降级协商、畸形或过期 Account token，以及 registry mutation 前的已验证 Account 不匹配。Host 集成覆盖固定跨 stale-owner 恢复的 generation 分配、同一 Host 上两个环境、attach/detach 精确回放、陈旧 permission 与 Session generation、禁止同 generation 复活、跨环境操作拒绝和断连清理。
