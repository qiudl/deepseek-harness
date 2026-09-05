# `@deepseek-ai/dsh-slark-cloud`

[English](README.md) | 中文

叠加在 [`dsh-base`](../base/README.zh.md) 与 [`dsh-web-app`](../web-app/README.zh.md) 之后的 Runtime Cell 组合包。独立的 Web 本地电脑灰度会把旧版 Slark 文件系统／Shell 能力面切换为带版本防护、可显式选择目标的文件专用 Device Provider。本地 subprocess、sandbox Provider、目录选择与 Cordis／插件／preset 创作界面始终禁用。

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-slark-cloud"
      ]
    }
  }
}
```

## 环境约定

| 变量 | 含义 |
|---|---|
| `DSH_SLARK_REMOTE_PROVIDER_V1=1` | 启用既有 Slark Device client 与旧版 v1 文件系统／Shell profile |
| `WEB_DSH_LOCAL_COMPUTER_V1=1` | 独立切换到 v2 Web 文件访问与目标选择；同时要求远程 Provider 开关开启 |
| `SLARK_DSH_GATEWAY_URL` | 精确的 Slark Gateway 内部 HTTP(S) origin |
| `SLARK_DSH_SERVICE_TOKEN` | 只用于 Gateway 请求 header 的 service bearer |
| `SLARK_DSH_AUTHORITY_DIRECTORY` | 私有绝对目录，其中包含每 session 的 Edge authority 文档与 `.publication-state` |
| `SLARK_DSH_WORKSPACE_ROOT` | 只读 workspace 投影的绝对根目录 |
| `SLARK_DSH_WORKSPACE_HANDLE` | 固定写入当前 DSH 子进程，并由身份与文件系统 Provider 共用的不透明 handle |
| `SLARK_DSH_ENVIRONMENT_ID` | 绑定到 Cell 刷新认证的 Slark 环境 |
| `SLARK_DSH_CELL_ID` | 绑定到唯一刷新密钥的 Runtime Cell id |
| `SLARK_DSH_CELL_REFRESH_KEY` | 通过进程环境而非 Cordis 配置注入的规范每 Cell HMAC 密钥 |
| `SLARK_DSH_EDGE_REFRESH_URL` | 精确的 loopback Edge authority 刷新 URL |

`DSH_SLARK_REMOTE_PROVIDER_V1` 缺失或不严格等于 `1` 时，全部远程配置行保持禁用，全部本地执行配置行仍被硬禁用。它为 `1` 而 `WEB_DSH_LOCAL_COMPUTER_V1` 缺失或为 `0` 时，保留已评审的旧版 v1 文件系统／Shell 能力面。只有两个开关都严格为 `1` 才启用 v2 身份、带版本防护的文件访问、目标选择和文件专用 persona；新开关的其他取值会使启动失败，任何模式都没有 cell 本地回退。

Slark Edge 必须在 `HttpOnly` session cookie 之外签发可读取的 `__Host-dsh_csrf` cookie。served Web client 会在不安全同源请求中把该 token 镜像到 `x-slark-dsh-csrf`；缺失或不匹配的 token 会被 Edge 拒绝，而独立版 DSH 因不存在该 cookie，请求保持不变。

启用 Web 本地电脑灰度时，云端 Agent preset 保留 DSH 的 goal、planning、compaction、skill、subagent、workflow、Web search，以及远程 `read`／`write`／`edit`，并移除 Shell、job、依赖 subprocess 的 `glob`／`grep`、持久 terminal、LSP、hook 和 Cordis 创作。灰度关闭时继续保留已评审的旧版远程 Shell／job 能力面。两种模式都禁用用户自定义 preset 发现与 preset 切换器。

身份适配器根据 `.publication-state` 注册所选只读 workspace 投影。该状态选择其他 workspace 时，部署 supervisor 会替换 DSH 子进程；每 session authority 刷新则无需重启子进程即可轮换短期 subject。

`pnpm run verify-slark-cloud-preset` 会组合真实的 base、Web 和 cloud 层；只要存在启用的本地 Provider、创作界面、用户 preset root、Provider 开关不一致、含密钥的身份配置或 cloud preset 禁止项，就会失败。该检查进入 CI 与 hygiene 聚合。

## 模型体验

### Slark 云端 persona

#### 模型看到的内容

灰度所选择的 `slark-cloud` persona 会准确描述当前能力面：v2 说明文件操作以显式选择的 Slark Desktop 设备为目标，并且 Shell／进程执行不可用；旧版 v1 继续说明远程文件与 Shell 操作。Device 或 Grant 失败都仍是最终结果。

#### Token 影响

组合包启用时，一个固定的部署 persona 会替换标准 persona。Device 身份与 authority 值不增加 token。

#### KV Cache 影响

组合包结构与 persona 文本不变时，前缀保持稳定。Device 身份与 authority 变化不会进入提示词前缀。

## 已知限制与延期工作

- 尚无远程文件搜索 Provider。Web profile 中不提供 Shell、`glob` 和 `grep`。
- 一个 DSH 子进程固定一个 Workspace Grant。切换 workspace 需要由 Slark supervisor 替换该子进程。
- 本组合包只提供配置和静态证明；Edge／Cell 进程隔离、authority 发布、supervisor 重载、资源限额、健康检查和 draining 属于 Slark 部署任务。
