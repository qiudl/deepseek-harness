# `@deepseek-ai/dsh-slark-identity`

[English](README.md) | 中文

面向隔离 DSH Runtime Cell 的 Slark Edge 身份适配器。它绑定 [`SlarkDeviceClient`](../../slark/device-client/README.zh.md) 的 authority source，从受信 agent 与工具执行事件取得 DSH Session id，并在每次远程操作时读取由 Edge 持有的 JSON 文件，从中取得当前 subject token、设备及 Workspace Grant 围栏。

## 配置

| 字段 | 必填 | 含义 |
|---|---:|---|
| `authorityFile` | 是 | Edge 原子替换的 authority 文档绝对路径；适配器拒绝符号链接、非普通文件、组／其他用户可访问权限、空文件和超大文件 |
| `expectedWorkspaceHandle` | 是 | 固定写入 Runtime Cell 远程文件系统与 Shell Provider 组合的 workspace handle |
| `maxAuthorityBytes` | 否 | authority 文档最大字节数；默认 64 KiB，硬上限 256 KiB |

文档采用精确字段：`protocol_version=1`、`kind=slark-dsh-runtime-authority-v1`，以及环境、assignment、generation、owner、个人项目、subject token、computer、workspace、Grant、epoch 和过期事实。适配器每次使用都会校验完整文档，拒绝过期 subject，并拒绝与 Provider 组合不一致的 workspace handle。Edge 必须以原子替换方式发布更新，权限为 `0600` 或更严格；部分写入或权限过宽的文档会使远程执行不可用。

`runForSession(sessionId, operation)` 为受信的非工具工作显式设置作用域。内置的 `tools/execute` 与 `agent/pre-step` listener 会自动应用同一作用域，包括从这些操作派生的异步后台工作。缺少任一作用域时直接调用 Device client 会以 `identity_unavailable` 失败。

## 模型体验

无，因为适配器不会让 Slark 身份进入模型请求或 session log，而 Provider 失败只公开稳定错误。

#### KV Cache 影响

无。身份事实不会进入模型请求或 session log。

## 已知限制与延期工作

- 一次 Runtime Cell 启动只固定一个 `expectedWorkspaceHandle`。选择另一个 Workspace Grant 需要新建或重新组合 cell；只替换 authority 文件不能重绑 Provider。
- Edge 部署与 authority 原子发布属于 Slark 部署层。缺少注入文件时加载本适配器会明确失败。
- 位于工具执行和 pre-step 处理之外的受信直接 Provider 调用方必须使用 `runForSession`；不存在进程级隐式回退身份。
