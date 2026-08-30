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

## 考虑过的替代方案

**保留 Desktop 所有的临时页面。** 拒绝，因为它只能证明导航外壳，不能证明 DSH 启动、session UI、上下文确认或正式 Harness runtime 的使用。

**把 DSH 托管在企业 Slark 服务中。** 拒绝，因为这会把个人模型凭证和算力移入企业基础设施，违反个人电脑工作台边界。

**在 DSH 内直接加载企业 Slark 页面。** 拒绝，因为企业项目导航属于 Slark；这种方案会让个人工作台依赖 Slark renderer 和认证内部实现，而不是 agent 协作协议。

**把企业个人项目视为远程文件系统或 Token 池。** 拒绝，因为该项目是协作权限与路由上下文；本机 DSH 执行仍发生在用户电脑上。

## 验证

包级协议测试通过真实 Unix socket 执行 registration challenge、proof、ACP 初始化、上下文应用和 acknowledgement。交付组合构建包含 opt-in row，普通 Web profile 则保持禁用。本机产品验收启动正式构建的 Web profile，从已安装 Slark Desktop 打开它，在两个企业个人项目上下文之间切换，并返回所选的 Slark 企业页。

## 后果

Slark 与 DSH 在共享一个已认证协作上下文的同时，继续保持独立的产品和资源归属。代价是 Desktop、daemon、DSH Web 三个进程的生命周期，以及必须保持 socket、key、installation identity、可执行文件身份与 loopback origin 一致的 launcher 契约。这些值不一致时，Slark 无法使用 DSH，但 DSH 的独立运行不受影响。
