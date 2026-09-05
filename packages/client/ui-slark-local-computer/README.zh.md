# `@deepseek-ai/dsh-client-ui-slark-local-computer`

[English](README.md) | 中文

面向 Slark Web DSH 本地电脑目标的浏览器展示插件。它占用 `sidebar.footer.action`，显示所选电脑和已授权 workspace 且不暴露不透明标识，并提供显式目标选择器。

## 行为

- 插件会在挂载、窗口获得焦点、打开选择器以及每 15 秒状态轮询时读取同源 Slark Edge API。响应经过字节上限与精确字段校验。
- 用户确认后发送一次带有所选 Grant 和当前发布版本的 `PUT`。CAS 冲突会刷新列表并要求重新确认；客户端绝不重试或自动选择目标。
- 切换成功后遵循 Edge 返回的 `reload_required`。Edge 持有所选目标的持久化状态和 Runtime Cell 替换职责；组件状态只保存选择器开关与当前候选项。
- connection 服务提供带 CSRF 认证的同源请求。凭据以及 computer、Grant 或 assignment 标识都不会进入可见错误。

## 模型体验

### 本地电脑目标控制

#### 模型看到的内容

不增加提示词段落、工具 schema 或工具结果。所选 `web_dsh_v1` 目标决定由哪个 Slark 远程文件系统处理既有文件操作，但本展示插件不增加模型可见内容。

#### Token 影响

本包不直接增加 Token。文件操作结果由文件系统 Provider 产生，并沿用该包的 Token 行为。

#### KV Cache 影响

本插件不改变提示词前缀或既有消息。Edge 要求的页面重载可能替换 Runtime Cell，但本包不增加可缓存内容。

## 已知限制与延期工作

- 一期只支持显式选择。Grant 创建、续期与撤销仍由 Slark Desktop 工作流负责。
- 可用性轮询只在当前页面内运行；Edge 提供不敏感事件流后可改用推送更新。
