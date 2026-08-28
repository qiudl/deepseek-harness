# `@deepseek-ai/dsh-slark-cloud`

[English](README.md) | 中文

叠加在 [`dsh-base`](../base/README.zh.md) 与 [`dsh-web-app`](../web-app/README.zh.md) 之后的 Runtime Cell 组合包。它用 Slark Device Provider 替换 cell 本地文件系统与 Shell Provider，移除本地 subprocess 和 sandbox Provider，禁用目录选择以及 Cordis／插件／preset 创作界面，并选择随包发布的 `slark-cloud` Agent preset。

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
| `DSH_SLARK_REMOTE_PROVIDER_V1=1` | 同时启用 Device client、身份适配器、远程文件系统与远程 Shell |
| `SLARK_DSH_GATEWAY_URL` | 精确的 Slark Gateway 内部 HTTP(S) origin |
| `SLARK_DSH_SERVICE_TOKEN` | 只用于 Gateway 请求 header 的 service bearer |
| `SLARK_DSH_AUTHORITY_DIRECTORY` | 私有绝对目录，其中包含每 session 的 Edge authority 文档与 `.publication-state` |
| `SLARK_DSH_WORKSPACE_ROOT` | 只读 workspace 投影的绝对根目录 |
| `SLARK_DSH_WORKSPACE_HANDLE` | 固定写入当前 DSH 子进程，并由身份、文件系统和 Shell Provider 共用的不透明 handle |
| `SLARK_DSH_ENVIRONMENT_ID` | 绑定到 Cell 刷新认证的 Slark 环境 |
| `SLARK_DSH_CELL_ID` | 绑定到唯一刷新密钥的 Runtime Cell id |
| `SLARK_DSH_CELL_REFRESH_KEY` | 通过进程环境而非 Cordis 配置注入的规范每 Cell HMAC 密钥 |
| `SLARK_DSH_EDGE_REFRESH_URL` | 精确的 loopback Edge authority 刷新 URL |

启用后缺少或无效的任何值都会在激活阶段明确失败。`DSH_SLARK_REMOTE_PROVIDER_V1` 缺失或不严格等于 `1` 时，全部远程配置行保持禁用，全部本地执行配置行仍被硬禁用。已有 session 可继续通过 Web 应用读取，但文件系统和 Shell 工具无法挂载；不存在本地回退。

Slark Edge 必须在 `HttpOnly` session cookie 之外签发可读取的 `__Host-dsh_csrf` cookie。served Web client 会在每次 API POST 中把该 token 镜像到 `x-slark-dsh-csrf`；缺失或不匹配的 token 会被 Edge 拒绝，而独立版 DSH 因不存在该 cookie，请求保持不变。

云端 Agent preset 保留 DSH 的 goal、planning、compaction、skill、subagent、workflow、job、Web search，以及远程 `read`／`write`／`edit`／`bash`。它不包含依赖 subprocess 的 `glob`／`grep`、持久 terminal、LSP、hook 和 Cordis 创作。该部署同时禁用用户自定义 preset 发现与 preset 切换器。CLI 把本 preset 放入由 Slark Device Provider 配置行决定是否选择的云端专用随附根目录，因此独立版 DSH 不会列出它，也不会改变本地 Provider 行为。

身份适配器根据 `.publication-state` 注册所选只读 workspace 投影。该状态选择其他 workspace 时，部署 supervisor 会替换 DSH 子进程；每 session authority 刷新则无需重启子进程即可轮换短期 subject。

`pnpm run verify-slark-cloud-preset` 会组合真实的 base、Web 和 cloud 层；只要存在启用的本地 Provider、创作界面、用户 preset root、Provider 开关不一致、含密钥的身份配置或 cloud preset 禁止项，就会失败。该检查进入 CI 与 hygiene 聚合。

## 模型体验

### Slark 云端 persona

#### 模型看到的内容

`slark-cloud` persona 明确说明：文件和 Shell 操作以选定 Slark Desktop 设备为目标，Device 或 Grant 失败即为最终结果。现有工具 schema 保持复用；仅本地可用的工具不会出现在目录中。

#### Token 影响

组合包启用时，一个固定的部署 persona 会替换标准 persona。Device 身份与 authority 值不增加 token。

#### KV Cache 影响

组合包结构与 persona 文本不变时，前缀保持稳定。Device 身份与 authority 变化不会进入提示词前缀。

## 已知限制与延期工作

- 尚无远程文件搜索 Provider。Agent 可通过远程 Shell 执行有界搜索命令，但 `glob` 和 `grep` 仍不提供。
- 一个 DSH 子进程固定一个 Workspace Grant。切换 workspace 需要由 Slark supervisor 替换该子进程。
- 本组合包只提供配置和静态证明；Edge／Cell 进程隔离、authority 发布、supervisor 重载、资源限额、健康检查和 draining 属于 Slark 部署任务。
