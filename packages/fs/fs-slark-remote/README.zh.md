# @deepseek-ai/dsh-fs-slark-remote

[English](README.md) | 中文

以 Slark Device Agent 实现 [`ctx.fs`](../fs/README.zh.md) 提供方约定。它在云端 Harness 运行单元中把一项已授权的本机目录投影为 `/workspace/<workspaceHandle>`，同时隐藏设备真实路径。

```ts ignore-check
import SlarkRemoteFileSystem from '@deepseek-ai/dsh-fs-slark-remote'

await ctx.plugin(SlarkRemoteFileSystem, {
  callerProfile: 'web_dsh_v1',
  workspaceHandle: 'opaque-workspace-handle',
})
```

## 行为

- 所有模型与进程坐标都会规范化为虚拟工作区根下的 POSIX 路径。指向根外的绝对路径、`..` 逃逸、反斜杠、控制字符、超长路径和 Device 暂存目录片段会在创建任务前以 `FS_SANDBOX_DENIED` 失败。
- `resolve`、元数据和目录列表会校验远程结果的精确结构。返回目标保留不透明 Device 身份，只暴露虚拟展示路径，绝不泄露 macOS 或 Windows 上选定目录的真实位置。
- 文本和字节读取使用有界 base64 分页。后续每页都携带首页版本，因此并发变化会以 `FS_STALE_VERSION` 失败；UTF-8 解码可跨分页边界，非法 UTF-8 和 NUL 字节样本以 `FS_NOT_TEXT` 失败。
- 旧调用方保留带防护与无条件变更语义。`web_dsh_v1` profile 使用 v2 协议，拒绝非 NFC 路径，并要求每次写入或编辑在创建 Device Task 前携带已观察版本。
- 提供方报告 `workspace-write`，因为 Device Workspace Grant 会限制每次变更。设备、Grant 或网络不可用时，绝不会回退到 `fs-local`。

## 模型体验

通过 `dsh-tool-fs` 间接影响模型；该工具保留现有 `read`、`write` 和 `edit` schema，并且只展示 `/workspace/<workspaceHandle>/...` 路径。

#### KV Cache 影响

只有虚拟工作区路径可能出现在工具结果中；不会引入新的工具 schema 或提示词前缀。

## 已知限制与延后工作

- 搜索工具仍由子进程支持。Web DSH profile 不提供 Shell、`glob` 或 `grep`；本文件系统包不会新增搜索 RPC。
- 整文件编辑仍受 Device Agent 的有界 payload 与结果上限约束。大型交付物使用 artifact。
- 可用性依赖有效的 Slark Desktop/daemon 连接与 Workspace Grant；设备离线会成为明确的远程 I/O 失败。
