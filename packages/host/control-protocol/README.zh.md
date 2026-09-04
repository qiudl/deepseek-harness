---
description: "Desktop 与 DSH Host 身份协商和控制错误所用的严格规范化线协议。"
kind: "package-reference"
---

# dsh-host-control-protocol

[English](README.md) | 中文

## 概述

这个零 I/O 库拥有 Desktop Broker 与唯一 DSH Host Supervisor 共享的本地控制线协议。版本 1 从带签名的 `host.inspect` 挑战交换开始，并包含 Profile lease 与迁移导出载荷。后续操作必须保留本包的规范 JSON-Lines 信封、品牌化身份、有界帧和脱敏错误词汇。

该传输不是 JSON-RPC。畸形行是必须关闭连接的协议违规，不能被忽略后继续读取。

## 目录

- [线协议约定](#wire-contract)
- [挑战认证](#challenge-authentication)
- [API](#api)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="wire-contract"></a>
## 线协议约定

- 每帧恰好一个 UTF-8 JSON 对象和一个结尾 LF；拒绝 CRLF、多行、重复或乱序键、未知字段、非规范数字和尾随数据。
- JSON 对象最多 65,536 个 UTF-8 字节，不含 LF。传输层必须在缓冲时执行同一上限；字符串编解码器无法收回调用方已经累积的字节。
- UUID 使用小写 RFC 变体；nonce 与 Ed25519 材料使用规范无填充 base64url；SHA-256 摘要使用小写十六进制。
- capability 是排序、去重的点分 token，且必须包含 `host.inspect`；未协商方法显式拒绝。
- 错误只暴露稳定 code、是否可重试和 correlation id；异常文本和本地路径不得进入帧。

<a id="challenge-authentication"></a>
## 挑战认证

`encodeHostInspectSignaturePayload(request, response)` 返回由安装级 Ed25519 密钥签名的精确 UTF-8 字节。带域隔离的声明绑定 request id、Desktop client id、challenge、选定版本、Host 与安装 id、安装公钥、generation、process nonce、capability 和可执行文件摘要。

签名响应包含为当前进程分配的持久正数 Host generation。每个已授权请求都重复该 generation，因此针对旧 Host 进程完成认证的请求无法跨越重启边界。响应里的公钥本身不构成信任。Desktop Broker 必须将其与已认证安装记录匹配，并独立比对对端可执行文件的代码签名摘要后才接受签名。迁移流程只能依据其显式同意和校验策略建立该记录；普通连接绝不能静默信任新密钥。

`session.attach` 把一条已认证连接绑定到一个权威环境、单调递增的 Session generation、不递减的 permission epoch、客户端协议版本 1，以及 Host 的精确 Profile 格式 generation。完全相同的重复请求是幂等的；冲突或陈旧值会失败关闭。提升一个环境的 permission epoch，会在其旧连接下次操作前 fence 对应 Session。`session.detach` 要求精确匹配当前活跃 generation，并返回安装范围内的活跃 Session 总数。同一 generation 一旦 detach 就不能再次 attach。其他操作必须先有已 attach 的 Session；操作携带的环境必须等于该连接已 attach 的环境。

<a id="api"></a>
## API

| 导出 | 职责 |
|---|---|
| `decodeHostControlFrame(source)` | 严格解析并规范化恰好一帧。 |
| `encodeHostControlFrame(frame)` | 运行时校验并发出恰好一帧规范数据。 |
| `encodeHostInspectSignaturePayload(request, response)` | 生成由黄金向量固定的域隔离签名字节。 |
| `HostControlProtocolError` | 带稳定 code 的脱敏本地失败。 |
| `HOST_CONTROL_MAX_FRAME_BYTES` | 传输共享缓冲上限。 |

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

参见[单 Host 控制协议 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.zh.md)。

</details>

<a id="model-experience"></a>
## 模型体验

无，因为这个本地 Host 控制编解码器不注册任何面向模型的内容。

#### KV Cache 影响

无直接失效；协议不会贡献模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **操作集合有明确上限**——版本 1 解析 `host.inspect`、Session attach/detach、Profile open/status/lease-close、迁移导出 begin/read 与通用错误。Environment approval 与 upgrade 操作需要显式扩展协议。
- **传输上限由外部执行**——Unix domain socket carrier 必须在字节上限停止读取，并在首次 codec 失败时关闭连接。
- **密码学策略由外部执行**——密钥持久化、代码签名检查、挑战签名与验证、重放存储和密钥轮换属于 Host identity 与 Desktop broker 包。
