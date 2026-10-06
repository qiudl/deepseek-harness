# @deepseek-ai/dsh-web-frontend

[English](README.md) | 中文

此应用构建 DSH Web Client 的浏览器入口。受支持的 Node 启动器为 [`dsh web`](../cli/README.zh.md)；构建此静态应用不会启动 Host 或创建 Profile。

## Slark 远程载体

独立的 `remote-bootstrap` 构建入口将隔离页面连接到 Slark 父页面。`VITE_DSH_REMOTE_PARENT_ORIGIN` 必须为父页面准确的 HTTPS origin。载体只接受来自该父窗口、origin 且携带原 nonce 的一个 MessagePort。经过认证的 Host 启动字节和 Client bundle 均由该端口传入。

Client 插件应用前，载体通过端口读取 `/__collaboration__`。父页面声明 `dsh-remote-collaboration/v1` 且方法仅为 `workspace` 时，安装范围桥。能力元数据缺失、无效、未知或超时时，不安装此桥，普通远程聊天仍可用。五秒发现期限也覆盖响应体读取。

范围桥只将已捕获的工作区、会话坐标和一个 `get`、`apply`、`projects` 或 `agents` 操作转发给父页面的 `collaboration/workspace` RPC。它检查 RPC 身份、嵌套结果、工作区、范围版本和目录字段，不携带账户凭据或可选电脑身份，也不使用浏览器网络 fetch。请求最多32 KiB，完整响应最多256 KiB。三十秒操作期限覆盖响应体读取。已发出的保存失败后需要重新读取，因为取消不能确定保存是否已提交。页面退出会取消正在处理的工作并移除自身的桥，迟到的能力发现不能安装它。

范围支持不代表独立任务执行。此桥声明执行不可用，不暴露提交或结果投递方法。Client 范围区域可管理保存的项目选择；Agent 提交和结果轮询要求其桥声明完整执行能力。执行能力可用时，任务分配在普通聊天中使用明确的 Agent 提及。

## 验证

[远程载体测试](tests/remote-boot.spec.ts) 覆盖认证握手和安装顺序。[范围消费者测试](tests/remote-collaboration.spec.ts) 使用真实 WorkerTunnel 和 MessagePort，覆盖拒绝、取消和期限。这些隔离测试不代表真实 Account、provider 或独立 Agent 执行验收通过。
