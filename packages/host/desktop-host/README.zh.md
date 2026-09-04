---
description: "供可信 Desktop 代理使用的本机单 DSH Host 权威与已认证 Unix 传输。"
kind: "package-bundle"
---

# dsh-desktop-host

[English](README.md) | 中文

## 概述

本包提供 Desktop Main 使用的本机 DSH Host 权威。它让 issuer-qualified Person Profile 独立于 Slark 环境，串行化同一会话命令，围栏审批与环境上下文租约，监管相互隔离的 Profile worker，并提供 owner-only 的已认证 Unix socket。Host 控制组件不拥有 HTTP listener；产品组合会启动既有 `dsh web` worker，由 Host 自行兑换一次性启动 URL，并且只向可信 Main 返回已校验的 loopback origin 与 HttpOnly Cookie 名称／值。启动 token 和文件系统路径都不会进入 Renderer。

`discoverUnixHost` 返回 `running`、`stopped` 或 `unknown`。只有注册表信任的 endpoint 确认没有监听进程时才返回 `stopped`；UID、安装密钥、可执行文件签名、challenge、帧或 socket 类型验证失败一律返回 `unknown`。

## 目录

- [Desktop adapter](#desktop-adapter)
- [Profile 与执行权威](#profile-and-execution-authority)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="desktop-adapter"></a>
## Desktop adapter

`UnixHostClient` 提供 Profile ensure／restore／status／open／view activation／close 与 owner-only 迁移操作。`profile.ensure_account_token` capability 标识 Host 接受带 token 的 `profile.ensure` 载荷；当该 capability 缺失时，任一 peer 都会在 mutation 前报告 `upgrade_required`。`profile.ensure` 要求携带面向 `dsh-host` audience 的短时规范 DSH Account token；Host 离线校验该 token，并在任何 Profile registry mutation 前要求其 issuer 与 subject 和请求账号一致。每个操作都接受 `AbortSignal`。中止会销毁已认证连接，Host 会撤销该连接拥有的全部 view lease 和 Profile 解锁引用；另一个已独立证明同一 Profile 的 staging 或 production 连接仍保持授权。

连接以 `host.inspect` 开始：Desktop 提供新鲜 challenge，并校验安装 Ed25519 签名、可信安装 id 与公钥、peer UID、可执行文件签名摘要、Host process nonce、runtime generation 和持久 Host generation。后续帧重复 client、Host、process 与 Host-generation 身份，并携带最长 30 秒、只能使用一次的 JTI。

Broker 在任何 Profile 或 migration 操作前，把恰好一个环境 Session attach 到连接。Session 与 permission generation 不得倒退，协议和 Profile 格式必须匹配，携带环境的操作不得越过已 attach 的环境。完全相同的 attach 或 detach 重试是幂等的；已 detach 的 generation 不能重新激活。连接关闭会移除其活跃 Session 并释放 Profile 引用。

<a id="profile-and-execution-authority"></a>
## Profile 与执行权威

Profile registry 只保存规范 DSH Account issuer 与 opaque subject 的设备密钥 HMAC、opaque Profile id、按环境划分的当前 binding handle／version，以及 opaque Keychain handle。同一个人的 staging 与 production binding 解析到同一 Profile；更高的服务端签名 binding version 只原子替换对应环境的旧 handle，并使旧签名 selector 失效。文件中不含原始账号身份或 Main vault 的 32 字节解锁材料，只持久化域隔离 verifier；常量时间校验成功后才授权当前已认证连接。

`profile.ensure` 返回绑定 installation、Profile、binding generation、runtime generation 与 schema generation 的 Host 签名 opaque selector。`profile.restore` 接受该 selector、精确 Keychain handle 与新鲜 Main-vault material。跨 installation 复制、binding 轮换后重放、猜测 handle／material，或证明连接断开，都会 fail closed。

macOS 启动组合会校验 owner-only 且非符号链接的根目录，只启动一个安装级 Host，为每次成功的所有权尝试原子分配持久 Host generation，分别检查 Node executable 与固定 DSH entrypoint，按照嵌入应用发布版本提供的 SHA-256 pin 校验 Account 公钥环，执行原生 peer PID／executable／code-signature attestation，并发布不含秘密的精确 `~/.dsh/host/registration.v1.json` discovery 记录。Desktop 窗口可以 attach 或 detach 自己的环境 Session，但窗口或应用退出不终止共享 Host；更新、移除或专用 Host 生命周期所有权负责停机。Profile worker 不继承 ambient environment。Host 校验子进程确实拥有其报告的 loopback listener，自行把一次性启动 token 兑换为签名 Cookie，确认未认证 `/` 为 401、携 Cookie 的 `/` 为 200，然后立即丢弃 token。

命令写入按 Profile 与 Session 串行，不同 Session 可并发。fsync 日志在执行前记录 `started`，随后记录 committed outcome；两者之间崩溃恢复为 `unknown`，绝不推断成功。审批决策同时比较 payload hash、decision version、window generation 与过期时间。环境上下文只附着到 Session lease，不形成 Profile 全局状态。

<a id="model-experience"></a>
## 模型体验

无，因为本包没有面向模型的注册。

#### KV Cache 影响

不会直接失效；Host 控制事实不进入模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **解锁材料仍由嵌入应用拥有**——Slark Main 必须把随机 32 字节 Profile material 保存在 macOS Keychain／safeStorage 中，并且只通过已认证 Main-to-Host 链路提供；它绝不能进入 Renderer、argv、environment、日志或 registration 文件。
- **Account access 与 session 绑定**——Slark Main 必须从 DSH Account 获取 `dsh-host` token，并且只通过已认证 Main-to-Host 链路提供。Host 不持久化或记录该凭据；token 过期后，Slark Main 必须刷新 Account session，`profile.ensure` 才能成功。
- **旧数据迁移在完整闭环前 fail closed**——只有 active Profile 的完整 owner-only bundle（session、settings、credential、workspace 与 Profile 配置）可被 stage 时，Host 才发布 export 能力。digest-only 或 session-only transfer 不会被宣称为安全迁移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

参见[单 Host 控制协议 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.zh.md)。

</details>
