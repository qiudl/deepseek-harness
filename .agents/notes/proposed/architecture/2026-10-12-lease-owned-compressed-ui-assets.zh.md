# Agent Note: 租约内的压缩 UI 资源

Status: proposed

[English](2026-10-12-lease-owned-compressed-ui-assets.md) | 中文

## Problem

REQ-20260930-0015 要求通过普通 Web 在五秒内访问远端原始 DSH 工作台。即使外层 daemon 合并请求，Host 每次读取 24 KiB 原始内容仍会增加私有 worker HTTP 和控制通道调用次数。

## Proposal

在 Profile worker 中压缩完整已授权插件资源，通过 `asset/read-gzip-chunk` 返回 24 KiB 压缩分块。使用签名检查结果中的 `profile.remote_ui_asset_gzip` 协商新增端点。未声明该能力的对端保留现有端点。worker 当前单个缓存项持有原始字节和共享压缩 Promise，不保留授权判断。

保留当前注入表的精确成员检查、同源脚本限制、Account 与视图租约校验、取消、原始 SHA-256 校验及完整 64 KiB 帧上限。原始字节限制为 8 MiB，gzip 字节限制为 8 MiB 加 64 KiB。daemon 和 Web 消费方必须保留这些上限，只能在组装完整压缩资源后解压。

## Alternatives considered

提高控制帧上限会增加保留的数据，却不能消除重复的 worker 原始读取。通过公共资源服务器发布私有模块会改变授权和交付前提。缓存注入授权判断可能在撤销后继续有效。完整资源压缩可以减少读取次数，同时保留现有授权归属。

## Acceptance criteria

旧对端保留原始读取。客户端和服务端均以签名能力检查控制执行。多块解压必须还原精确原始字节，包括不可压缩及空资源。注入撤销、工作取消或视图租约失效后拒绝缓存读取。关闭需求前，匹配的 Slark 消费方及正式发布产物必须通过普通 Web 到 Boston 功能验收，以及冷、热连接完整工作台 P95 测量。

## Risks

压缩增加有界 worker 内存和 CPU 开销。迟到完成不能越过取消；压缩失败不能污染缓存。仅资源传输更快不能证明工作台达到五秒要求。
