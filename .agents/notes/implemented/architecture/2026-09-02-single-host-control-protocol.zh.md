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

## 缺陷分析迭代

第 1 轮发现四个缺陷：出站值没有运行时校验、base64url 尾部未强制规范、Desktop client id 复用了 Host 身份品牌、版本协商只接受 `[1]`。四项均有聚焦测试。

第 2 轮发现三个协议缺口：签名原文未定义、capability 响应可以缺少基线方法、Host 进程与安装身份可以坍缩为同值。域隔离签名向量、必需基线 capability、安装公钥、正数 generation 和身份分离检查已关闭这些缺口。

第 3 轮没有发现新的包内缺陷。传输缓冲、对端凭证检查、密码学验证、重放状态和操作载荷仍是明确的消费者职责，记录在包限制中，不在这里做半套实现。

## Alternatives considered

**复用 SDK JSON-RPC carrier。** 它是会跳过畸形行、且不拥有安装身份的 Agent Runtime stdio 协议，无法执行本地 supervisor 所需的连接级致命认证。

**信任 socket 路径或响应公钥。** 两者都可能被不可信本地进程替换。Broker 改为同时要求注册表中的安装信任与对已连接可执行文件的原生证据。

## 后果

协议会拒绝语义等价的 JSON。这减少解析器差异与跨语言歧义，但每个实现都必须遵守已提交黄金向量。未来 peer 仍可用 `[2,1]` 降级协商；版本 1 framing 是兼容 bootstrap。

Decoder 接收完整字符串，因此能拒绝超限帧，却不能阻止 transport 先缓冲它。Unix domain socket carrier 必须增量执行字节上限，并在首次错误时关闭。没有可信 request id 的无效输入不返回错误帧，只关闭连接。

## 测试

聚焦套件从已提交的 request、result、error 和签名原文向量开始，逐字节 round-trip。负向覆盖未知／缺失字段、空白、多帧、超限、伪造出站值、非规范 base64url、缺失基线 capability、身份复用和未来客户端降级协商。
