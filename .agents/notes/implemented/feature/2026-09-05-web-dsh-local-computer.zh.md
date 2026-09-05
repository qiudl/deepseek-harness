# Agent Note: Web DSH 通过显式选择的本地电脑执行带版本防护的文件访问

Status: implemented

[English](2026-09-05-web-dsh-local-computer.md) | 中文

## 问题

浏览器中的 DSH session 运行在云端 Runtime Cell，而用户的工作文件仍位于 Slark Desktop 电脑。若把这台电脑当作隐式目标或通用远程执行器，目标变化将不可见、一期范围之外的能力可能被放开，陈旧 Cell authority 也可能在选择或同意变化后继续有效。

## 决策

独立的 `WEB_DSH_LOCAL_COMPUTER_V1` 灰度把已启用的 Slark cloud Provider 从评审过的旧版 v1 文件系统／Shell 行为切换到名为 `web_dsh_v1` 的文件专用 Web 调用方；它默认关闭，并且还要求 `DSH_SLARK_REMOTE_PROVIDER_V1=1`。身份适配器只接受精确的 v2 runtime authority 文档，将 assignment generation 与选择发布版本同 `.publication-state` 对照，并把完整的同意、受保护根目录、broker 和 authority 围栏传给 Device client。Device client 要求请求与 authority 的调用方 profile 一致，并在传输前拒绝 Shell、进程与 artifact 操作。

`fs-slark-remote` 在该 profile 下只发送 `dsh-fs-request-v2`，只接受匹配的 v2 结果，拒绝非 NFC 路径，并要求写入和编辑携带预先观察所得的防护条件。旧 profile 保留 v1 解析与变更语义；v1 不能满足 Web 请求。

浏览器把 `ui-slark-local-computer` 贡献到 `sidebar.footer.action`。它展示不敏感的电脑与 workspace 标签，并在用户确认后发送一次带发布版本的 CAS 请求。发生冲突时刷新状态并要求再次确认。连接服务把调用限制在同源 `/api/slark/` 路径，并为不安全方法镜像 host-only CSRF Cookie。挂载、窗口聚焦、弹窗和轮询触发的并发刷新带有页面内单调序号，旧响应不能覆盖较新的选择。是否重载页面只由 Edge 响应决定，以使 Runtime Cell 替换和浏览器状态收敛。

新灰度开启时，Slark cloud preset 包含文件工具，但不包含 Shell、job、持久 terminal、`glob`、`grep` 或依赖 Shell 的权限 preset 控件；灰度关闭时，既有 v1 Shell／job 与权限能力面和匹配的 persona 保持不变。组合门禁同时证明两个分支，并拒绝任何会混合两套权限面或在没有 Shell 时仍启用依赖 Shell 的服务的开关表达式。

## 考虑过的替代方案

**为搜索保留远程 Shell。** 拒绝，因为 Shell 的执行权限远大于一期需要，而搜索便利不足以成为绕过安全文件 broker 边界的理由。

**自动选择唯一可用的电脑。** 拒绝，因为选择会改变 authority 并可能重启 Runtime Cell；即使只有一个选项，用户也必须看到并确认目标。

**由浏览器重试选择冲突。** 拒绝，因为重试可能覆盖其他标签页或设备上的较新选择。刷新后重新确认可保留用户的 CAS 意图。

**接受 v1 authority 并推断缺失的 Web 围栏。** 拒绝，因为推断策略或发布版本会把不完整的 authority 变成有效 authority。profile 匹配必须精确且关闭失败。

## 后果

Web 产品具有可见且显式的本地电脑目标，并且不能借该目标执行命令。目标、同意、策略、broker、assignment 或发布状态发生漂移时，会在权威 Device 边界之前或该边界上失败。Edge 浏览器 DTO 按精确且有大小上限的结构解析，其中包括 `computer_display_code`；目标列表的 publication version 可从 0 开始，而已签发 authority 的 publication fence 仍必须为正数。现有非 Web 集成继续兼容 v1。代价是一期没有远程文件搜索，Edge 替换 Cell 时需要重载页面，并且在安全推送通道出现前使用页面内轮询。
