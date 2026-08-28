# `@deepseek-ai/dsh-slark-identity`

[English](README.md) | 中文

面向隔离 DSH Runtime Cell 的 Slark Edge 身份适配器。它绑定 [`SlarkDeviceClient`](../../slark/device-client/README.zh.md) 的 authority source，从受信 agent 与工具执行事件取得 DSH Session id，并按 session 读取或刷新短期 subject 及设备、Workspace Grant 围栏，不向浏览器或模型暴露凭据。

## 配置

| 字段 | 必填 | 含义 |
|---|---:|---|
| `authorityDirectory` | 是 | 私有绝对目录，其中每个 DSH Session 对应一份由 Edge 原子替换的 `<sessionId>.json` authority 文档 |
| `workspaceRoot` | 是 | 包含所选 workspace 只读本地投影的私有绝对根目录 |
| `expectedWorkspaceHandle` | 是 | 固定写入 Runtime Cell 远程文件系统与 Shell Provider 组合的 workspace handle |
| `environmentId` | 是 | 绑定到 Cell 刷新认证的 Slark 环境 |
| `cellId` | 是 | 绑定到唯一刷新密钥的 Runtime Cell id |
| `refreshUrl` | 是 | 精确的 loopback Slark Edge authority 刷新 URL |
| `refreshKey` | 否 | 规范的 32 字节 base64url Cell 密钥；省略时读取 `SLARK_DSH_CELL_REFRESH_KEY`，不会把密钥放入 Cordis 配置 |
| `refreshBeforeExpiryMs` | 否 | subject 过期前的刷新窗口；默认 60 秒，最大 240 秒 |
| `refreshTimeoutMs` | 否 | 一次 Edge 刷新请求的超时；默认 5 秒，最大 30 秒 |
| `maxAuthorityBytes` | 否 | authority 文档最大字节数；默认 64 KiB，硬上限 256 KiB |

每份文档采用精确字段：`protocol_version=1`、`kind=slark-dsh-runtime-authority-v1`，以及环境、assignment、generation、owner、个人项目、subject token、computer、workspace handle 与别名、Grant、epoch 和过期事实。适配器以禁止跟随符号链接的方式打开 session 专属文件，只接受 `0600` 或由 Writer 持有的 `0640` 权限，每次使用都校验全部字段，并拒绝过期或与组合不一致的 authority。

authority 缺失或即将过期时，每个 session 只发起一次受请求正文约束的 HMAC 刷新；并发调用方共享该请求，随后重新读取 Writer 持有的文件。Edge 响应只包含 workspace 元数据与过期时间，绝不返回 subject token。刷新失败、发布格式错误或刷新后文件仍缺失时，远程执行不可用。

`runForSession(sessionId, operation)` 为受信的非工具工作显式设置作用域。内置的 `tools/execute` 与 `agent/pre-step` listener 会自动应用同一作用域，包括从这些操作派生的异步后台工作。缺少任一作用域时直接调用 Device client 会以 `identity_unavailable` 失败。

激活时，适配器会校验 `.publication-state`，以 Slark 别名把所选只读投影注册到 workspace 注册表，并删除陈旧的 Slark 托管注册项。所选 Grant 变化时，Runtime Cell supervisor 使用已发布的 workspace handle 启动新的 DSH 子进程，使 Provider 配置与 workspace 注册同步变化。

## 模型体验

无，因为适配器不会让 Slark 身份进入模型请求或 session log，而 Provider 失败只公开稳定错误。

#### KV Cache 影响

无。身份事实不会进入模型请求或 session log。

## 已知限制与延期工作

- 一个 DSH 子进程只固定一个 `expectedWorkspaceHandle`。选择另一个 Workspace Grant 时，部署 supervisor 必须替换该子进程；只修改 session authority 文件不能重绑 Provider。
- Edge 部署、每 Cell 刷新密钥、authority 原子发布与 supervisor 重载属于 Slark 部署层。缺少这些控制时加载本适配器会明确失败。
- 位于工具执行和 pre-step 处理之外的受信直接 Provider 调用方必须使用 `runForSession`；不存在进程级隐式回退身份。
