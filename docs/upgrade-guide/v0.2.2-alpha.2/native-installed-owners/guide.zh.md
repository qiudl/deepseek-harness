---
kind: upgrade-guide
description: "Native runtime-entry 资格改用 schema3 安装 owner 资源，替代所选文件 pins。"
---

# Native entry 要求已安装 owner 元数据

[English](guide.md) | 中文

## 变更

使用所选文件 pins 的 Native runtime-entry 嵌入配置不再声明 `profile.runtime_entry`。这些历史配置仍可解析用于元数据读取，但不能证明当前安装资格。普通消费保留现有早期回退路径。已有 entry、observation、attribution 和交付 receipt 字节不变。

## 迁移

1. 一起升级嵌入程序验证过的 runtime payload 和 canonical DS 包。通过其签名安装资源流程生成 `native-origins/owners-v3.json`，不要手工拼 pin 列表或复制其他安装的 manifest。
2. 通过 `runtimeEntryOriginsJson` 传入可信 schema3 资源引用。嵌入程序在验证签名资源后提供固定 manifest 路径和原始字节 SHA；Profile patch 和操作请求不能提供这些值。
3. 在实际安装的 Profile 上检查 `profile.runtime_entry`，并确认其原始 DS Loader 注册处于活动状态。owner、包选择或 native 二进制缺失或变化时，Native 保持不可用。应重新安装匹配的已验证发行包，不应修改限额或删除原 entry 记录。

[Desktop Host](../../../../packages/host/desktop-host/README.zh.md) 负责当前 Account/worker 和安装检查。
