# Agent Note：单 Host 本地控制协议

状态：已实现

[English](2026-09-02-single-host-control-protocol.md) | 中文

## 问题

REQ-20260901-0020 要让一台机器上的唯一 DSH Host 同时服务 Slark staging 与生产环境的 Desktop 客户端。仓库现有 SDK JSON-RPC 不适合这个边界：它是 Agent Runtime 的 stdio carrier，会忽略畸形行，也不拥有安装身份。复用它会让安全敏感的本地 supervisor 在歧义输入后继续运行，并把 Desktop 生命周期控制耦合进公开 SDK 面。

Host 与 Broker 在信任任何 profile、environment、session、migration 或 upgrade 命令前，需要独立的第一条消息。它必须协商协议版本、用新鲜 challenge 证明活性、识别安装与当前进程，并准确声明后续可用操作。

## 决策

`@deepseek-ai/dsh-host-control-protocol` 是 Host 组的零 I/O 库，拥有规范 JSON-Lines 信封、64 KiB 对象上限、品牌化跨边界身份、有界错误词汇和版本 1 的 `host.inspect` 交换。畸形输入必须关闭连接。Decoder 要求精确键顺序与形状，随后重新编码规范值并逐字节比较，从而拒绝重复键、数字替代写法、空白变体、CRLF、多行和未知字段。Encoder 也走同一运行时校验，不信任被擦除的 TypeScript 类型。

请求携带新鲜 32 字节 challenge、临时 Desktop client id，以及包含版本 1 的降序去重版本列表。响应选中版本 1，携带互不相同的 Host 进程 id 与持久安装 id、安装级 Ed25519 公钥、正数 runtime/schema generation、process nonce、包含 `host.inspect` 的排序去重 capability，以及可由 Broker 独立比对的可执行文件签名摘要。

挑战签名不是笼统的“签响应 JSON”。`encodeHostInspectSignaturePayload` 构造带域隔离的声明，绑定除签名本身之外的全部请求与响应事实；黄金向量固定非 TypeScript 实现必须使用的精确 UTF-8 字节。响应公钥只用于识别，不能自证可信：Broker 必须将其与可信安装记录匹配，并独立检查对端可执行文件后才接受签名。

后续操作任务扩展已解码载荷联合，不得削弱帧边界，也不得把 transport、authorization、migration 或 Host 进程状态放进本包。

`profile.ensure` 携带由规范 DSH Account 权威为 `dsh-host` audience 签发的短时 ES256 access token。`profile.ensure_account_token` capability 标识这一载荷修订。新客户端拒绝向缺少该 capability 的 Host 发送修订载荷；新 Host 仍解析旧载荷，并在访问 registry 前返回 `upgrade_required`。Host 使用 owner-private 公钥环校验精确 JWT 形状与签名，该公钥环的 SHA-256 摘要由嵌入应用发布版本固定；Host 随后要求已验证的 issuer 与 subject 等于 Desktop 提供的账号字段，才会读取或修改 Profile registry。Host 既不持久化也不记录该 token。

`profile.bootstrap_local`、`profile.restore_local` 与 `profile.open_local` 负责不依赖账号的本地 Profile 路径。Bootstrap 只接收 Main-vault key handle 和 32 字节 unlock material，并返回与账号 provisioning 相同、绑定 installation 与 generation 的 Host selector。Restore 校验 selector、本地专用 Profile kind、精确 generation 与新鲜 unlock material；open 要求该 Profile 已被同一 authenticated connection 的 bootstrap 或 restore 解锁。这些操作绝不接收或创建 Account binding、issuer、subject、token 或 environment assertion。各自发布的 capability 让新版 Desktop 能在向旧 Host 发送本地 unlock material 前报告 `upgrade_required`。

REQ-20260909-0002 为 selector 缓存缺失的已有 Account Profile 增加第三种、域隔离的访问 scope。`profile.recovery_inspect` 只接收可信 Desktop Main 从 vault 枚举出的不透明 key handle，在不启动 worker 或插件的前提下，对已有 persistence、owner-state、manifest、lockfile、插件链接与 runtime 内容执行 existing-only 检查。用户通过原生确认后调用 `profile.recover_offline_account`；Host 再次预检、验证 Main-vault unlock material，并只向该 authenticated connection 授予 `offline_local`。`profile.open_offline_account` 不能消费 connected 或 local-anonymous selector，`profile.recovery_status` 让超时确认可以按同一 operation 幂等查询。这些 capability 只在两个恢复 adapter 都安装时发布。

升级替换应用后，Host 不会静默继续依赖旧应用中的插件链接。确认后，它把完整 legacy runtime 复制进 owner-private、按内容寻址的 Profile 闭包，只重写预检计划证明过的链接，校验复制树摘要，并记录 prepared/committed journal。该路径不合并 Profile 目录、不创建空 owner state、不修改账号 binding，也不要求邮箱登录。Desktop 使用独立加密缓存保存 recovery selector；持久恢复权威仍是 Keychain proof 与 Host verifier。

`profile.open` 也是同一 authenticated connection 与 Profile 所拥有未过期 lease 的续期操作。续期保留 lease id 和 generation，按照 Host 时钟延后 expiry，并在上一个 handle 已消费后签发新的单次 activation handle。Desktop 刷新 HttpOnly bootstrap cookie 时无需替换活跃 renderer；disconnect、显式 close、Profile generation 变化和 expiry 仍会撤销 lease。

## 缺陷分析迭代

第 1 轮发现四个缺陷：出站值没有运行时校验、base64url 尾部未强制规范、Desktop client id 复用了 Host 身份品牌、版本协商只接受 `[1]`。四项均有聚焦测试。

第 2 轮发现三个协议缺口：签名原文未定义、capability 响应可以缺少基线方法、Host 进程与安装身份可以坍缩为同值。域隔离签名向量、必需基线 capability、安装公钥、正数 generation 和身份分离检查已关闭这些缺口。

第 3 轮没有发现新的包内缺陷。传输缓冲、对端凭证检查、密码学验证、重放状态和操作载荷仍是明确的消费者职责，记录在包限制中，不在这里做半套实现。

第 4 轮发现四个 Account 权威缺陷：token expiry 可以早于 issuance、必填字段静默改变版本 1 wire payload、调用方可以不经过精确 parser 构造 keyring，以及没有直接观测 registry 零 mutation 的负向路径。顺序化时间边界、已签名 capability 标记与旧载荷 `upgrade_required` 响应、强制经过 parser 的 verifier 构造，以及聚焦的零 mutation 覆盖关闭了这些缺陷。

第 5 轮发现两个可靠性缺陷：直接 parser 调用没有 keyring 字节上限，且 bundle patch 会加载 startup subpath，但该 subpath 缺少源码 alias。Parser 现在拥有与 startup 相同的 16 KiB 限制，`tsconfig.base.json` 也将 startup export 映射到源码。第 6 轮没有在 token 校验、密钥固定、滚动兼容、授权顺序、错误映射或凭据留存方面发现新缺陷。

第 7 轮审计离线恢复实现，发现 runtime facts 未绑定文件内容、静默选择会话最多候选、退出后保留 pending operation，以及二次预检 stale 被伪装成 worker failure。Runtime tree digest、原生显式选择、生命周期 reset 与精确 stale 传播关闭了这些问题。第 8 轮发现 operation 预约竞态、已撤销 operation 留存、短时 plan 无界增长、跨 scope grant 覆盖和缓存持久性不足；Host 现在会在异步复检前预约、清理 owner/candidate 状态、替换同 Profile plan、拒绝 scope 改写并 fsync 私有缓存。

第 9 轮沿 Web、Main、daemon、Host 完整产品路径检查，发现未实现仍宣告 capability、不可读 vault 被误报为冲突、映射错误落回通用工作台失败，以及 Web 入口在本地恢复前先触发 Account binding。现在 capability 反映真实 adapter，缺失与不可读 vault 分离，稳定恢复错误有可行动文案，已有本机数据先于任何可选 Account 流程打开。第 10 轮修复多个 legacy vault 间映射后 `not-found` 的处理、把超时失败状态统一进 Desktop 错误域，并移除会隐藏权限故障的 `existsSync` 过滤。第 11 轮发现内部绝对链接被改写到 staging 目录，原子 rename 后会断链；现在链接直接指向最终 content-addressed root，并在 rename 前后分别校验树摘要。第 12 轮发现运行时内部断链，以及词法上位于闭包内、但经第二层链接最终逃出的目标；恢复现在解析每个最终目标并要求其仍处于 runtime 闭包内。

## Alternatives considered

**复用 SDK JSON-RPC carrier。** 它是会跳过畸形行、且不拥有安装身份的 Agent Runtime stdio 协议，无法执行本地 supervisor 所需的连接级致命认证。

**信任 socket 路径或响应公钥。** 两者都可能被不可信本地进程替换。Broker 改为同时要求注册表中的安装信任与对已连接可执行文件的原生证据。

**让每个 Slark 环境声明 Account 身份。** staging 或 production assertion 会让环境成为 Account 权威，并可能为同一个人创建不同的机器 Profile。两个环境改为向唯一 Host 提交同一个规范 DSH Account 凭据。

**由 Desktop 关闭再重新打开 lease。** 先关闭会产生授权空档，还可能停止 Profile view origin，导致 renderer 被替换并丢失进行中的 UI 状态。重复执行 authenticated `profile.open` 会在 Host 内原子延长现有 lease。

**伪造替代 selector 或把 Account Profile 改成 local。** 两者都会绕过 Host 权威，并混淆 Account、local-anonymous 与 offline 访问。恢复改为证明已有 registry verifier，再由独立 `dsh-profile-offline-selector/v1` 域签发 selector。

**把旧 Profile 目录合并到新建本地 Profile。** Session 与插件状态拥有独立 generation 和所有权，目录复制会使回滚与来源不清。方案是在原地打开原 Profile，只把它依赖的外部 runtime 闭包私有化。

## 后果

账号 provisioning 捕获原 Profile 记录并执行登记，两者之间没有异步间隙。worker 失败只会在登记对象仍为当前对象时恢复原记录；并发变更会返回 `stale`。issuer 或 subject 替换时，仅查询目标身份无法识别原记录，因此回退由注册表而非 Desktop Host 调用方负责。缺少 worker 支持时，在变更前拒绝操作。该机制保留本地注册表元数据，并非跨云端的迁移事务；进程丢失恢复和云端授权仍需单独协调。

协议会拒绝语义等价的 JSON。这减少解析器差异与跨语言歧义，但每个实现都必须遵守已提交黄金向量。未来 peer 仍可用 `[2,1]` 降级协商；版本 1 framing 是兼容 bootstrap。

账号关联的 Profile 创建依赖一个仍可获取有效 Host-audience token 的 DSH Account session。本地专用 Profile 路径不依赖该 session，只有可信 Host、Keychain material 或本地 worker 不可用时才不可用。过期 Account token 只影响后续账号关联的 `profile.ensure` 重试。

活跃 Desktop 会定期续期其一分钟 view lease。Host 继续拥有 expiry 权威，且只延长同一 authenticated connection 与 Profile 所拥有的未过期 lease；inactive 或 disconnected Desktop 无法制造永久 lease。

本地 Account Profile 恢复刻意独立于 Slark 登录、环境 routing 与 DSH Account 邮箱验证。退出会撤销 connection grant 并清理重连 selector，但不会删除 Main vault 或 Profile 数据；后续连接可以重新证明。`offline_local` 只启用本机会话与已安装插件；云同步和 connected 能力仍需独立在线授权转换，不能由相同邮箱推断。

Decoder 接收完整字符串，因此能拒绝超限帧，却不能阻止 transport 先缓冲它。Unix domain socket carrier 必须增量执行字节上限，并在首次错误时关闭。没有可信 request id 的无效输入不返回错误帧，只关闭连接。

## 测试

聚焦套件从已提交的 request、result、error 和签名原文向量开始，逐字节 round-trip。负向覆盖未知／缺失字段、空白、多帧、超限、伪造出站值、非规范 base64url、缺失基线 capability、身份复用、未来客户端降级协商、畸形或过期 Account token，以及 registry mutation 前的已验证 Account 不匹配。Host 生命周期覆盖证明：再次打开已激活 lease 会保留 id 和 generation，同时延后 expiry 并轮换单次 activation handle；本地 Profile 可以在没有 Account 凭据时 bootstrap、重连、restore 和 open。

离线恢复覆盖 scope 分离、唯一 handle 解析、缺失 root 的只读行为、二次预检 stale、operation 幂等、断线撤销、条件 capability 发布、多 vault 选择、映射后 not-found 继续、不可读 vault 报告和超时状态映射。Runtime fixture 覆盖 legacy closure 复制、内容摘要校验、最终根绝对链接重写、原子发布、recovery journal 完成，以及断链、逃逸、特殊 inode 或不安全依赖拒绝。聚焦 recovery inspector 保持 statements、branches、functions、lines 四项 100%；任何用户批准的 materialization 前，真实 legacy Profile 只做只读检查。
