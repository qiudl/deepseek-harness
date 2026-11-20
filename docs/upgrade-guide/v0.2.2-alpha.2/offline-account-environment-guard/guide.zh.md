---
kind: upgrade-guide
description: "离线账号恢复的 Host 请求必须携带环境 UUID，并要求新的能力标记。"
---

# 离线账号恢复的环境校验

[English](guide.md) | 中文

## 变更

Host 控制请求 `profile.recovery_inspect`、`profile.recover_offline_account` 和 `profile.open_offline_account` 现在必须携带 `expected_environment_id`。Host 在恢复或打开前，将该 UUID 与账号 Profile 的持久绑定环境核对。绑定缺失、冲突或环境不同的 Profile 会被拒绝。客户端还必须确认 `host.inspect` 提供 `profile.offline_environment_guard`；旧版 Host 不能执行离线账号恢复。

## 迁移

1. 更新 `UnixHostClient.inspectOfflineAccountProfiles`、`recoverOfflineAccountProfile` 和 `openOfflineAccountProfile` 的调用方，从当前可信环境传入 `expectedEnvironmentId`。不要从缓存 selector 或密钥句柄所在目录推导环境。
2. 同时升级 Host 和客户端，确认 `host.inspect` 声明 `profile.offline_environment_guard`。
3. 分别测试绑定当前环境、绑定其他环境和无绑定的 Profile；只有第一种可以恢复并打开。
