# Agent Note: Desktop 中介的嵌入式 DSH 操作

Status: proposed

[English](2026-09-17-desktop-mediated-embedded-actions.md) | 中文

## 问题

嵌入式 DSH renderer 无法使用浏览器剪贴板与下载权限，因为 Slark Desktop 会主动拒绝这些权限。放宽 Electron permission handler 会向无关页面代码授予环境权限，也无法提供安全的原生另存为流程。Web 客户端还缺少与宿主无关、支持有界缩放、焦点管理和持久附件保存的图片查看器。

## 提案

提供版本化且仅供 DSH 使用的 preload API，支持写剪贴板和保存持久附件。每项操作都需要 preload 捕获的一次可信点击，以及有效的 Desktop 视图权限。主进程推导窗口、视图、origin、profile generation 和 lease；renderer 输入不能选择这些值。导航、替换视图、账号或 profile 变化、lease 变化、隐藏和销毁都会使待处理权限失效。

Web 客户端协商明确的版本一功能，并使用稳定结果码。嵌入式客户端在宿主拒绝操作后，绝不回退到浏览器 Clipboard API。普通浏览器部署保留现有剪贴板实现。图片查看器负责适应视口和 25–400% 手动缩放、锚点缩放、有界平移、键盘及指针输入、模态焦点和焦点归还。

### 附件交付

Session Controller 为目标 Session 日志中已有的附件引用提供精确的 `GET|HEAD /api/session.attachment-export` 请求。该路由要求经过认证的 Connection 请求和 `Sec-Slark-Desktop-Action: attachment-save-v1`。浏览器 JavaScript 不能设置这个保留 header，因此页面代码不能把该路由用作通用文件读取 API。HEAD 返回有界元数据；GET 在图片准入上限内缓冲规范化图片，并通过 `readFileStream` 以背压和取消语义传输逐字节文件。

Desktop 在打开系统另存为对话框前取得元数据，并在 GET 时再次执行授权。它在把响应流写入同目录的独占临时文件时校验身份、字节数和摘要。平台辅助程序拒绝链接和 reparse point，应用 macOS quarantine 或 Windows Mark of the Web，刷新数据并原子提交。renderer 代码绝不提供 URL 或目标路径。

### 版本和发布顺序

[`dsh-host-actions-v1.schema.json`](../../../../packages/api/session-controller/protocol/dsh-host-actions-v1.schema.json) 是语言无关的字段与常量记录，以固定摘要复制到 Desktop 仓库。DSH 可以先发布，因为宿主缺少能力时只会产生本地化的不可用结果。Desktop 独立发布每项功能，并保持现有权限和下载处理器关闭。

## 考虑过的替代方案

**为 DSH origin 开放浏览器剪贴板和下载。** 仅有 origin 信任不能证明当前活跃视图、当前 profile 权限或用户手势，而浏览器下载会接收并非由宿主持久 Session 引用推导的 URL。

**通过 JSON RPC 或 preload IPC 传输附件字节。** 图片和文件可能很大。聚合序列化会在多个进程间复制字节，并使取消和背压不可靠。

**使用 renderer 提供的文件名、URL 或路径。** 这些值会让受入侵页面代码重定向宿主 I/O。它们应由 Session 日志、认证路由元数据、系统对话框和原生文件辅助程序拥有。

## 验收标准

- 写剪贴板需要当前可见且聚焦的 DSH 内容视图和一次已消费的可信点击；读剪贴板继续不可用。
- 图片和文件导出只对目标 Session 日志中的精确持久引用成功；页面发起的导出路由请求必须失败。
- 图片查看支持有界缩放、平移、键盘操作、模态焦点和焦点归还，且不改变普通滚轮滚动。
- 导航和权限变化会取消活跃工作并抑制陈旧结果；清理会等待流、文件句柄、辅助程序和监听器关闭。
- macOS 和 Windows 保持全局权限拒绝，为下载文件添加平台来源标记，并通过相同协议向量。

## 风险

必须在受支持 Electron 版本证明主进程保留 header 请求可用，并且请求不会经过页面 service worker。原生另存为焦点切换需要显式模态 lease，防止对话框使自身权限失效。进程崩溃可能在用户选择的目录留下仅所有者可读写的随机临时文件；清理只在用户以后再次选择该目录时扫描该目录，不持久化敏感路径，也不扫描整个文件系统。
