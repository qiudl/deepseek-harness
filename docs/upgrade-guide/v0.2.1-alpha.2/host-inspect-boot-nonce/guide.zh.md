---
kind: upgrade-guide
description: "Host 控制客户端必须接受 host.inspect 结果中带签名的 boot_nonce 字段。"
---

# Host inspect 包含进程启动 nonce

[English](guide.md) | 中文

## 变更

`host.inspect` 结果新增 `boot_nonce`：每次 Host authority 进程启动生成规范 base64url nonce，并由安装密钥签名覆盖。仍按旧字段列表精确解析的客户端会拒绝升级后的 Host。

## 迁移

1. 更新 `HostInspectResult` 消费方，解析 `boot_nonce`，并在 `encodeHostInspectSignaturePayload` 验签时纳入该字段。保留原有安装与进程身份检查。
2. 将依赖 Host 内存见证的离线授权绑定到 `boot_nonce`。即使 Desktop 以相同 `host_instance_id` 和 `process_nonce` 配置重启 Host，新进程也须使旧离线授权失效。
3. 验证同一 Host authority 的两个连接返回相同 `boot_nonce`；新 authority 返回不同值，旧离线授权被拒绝。
