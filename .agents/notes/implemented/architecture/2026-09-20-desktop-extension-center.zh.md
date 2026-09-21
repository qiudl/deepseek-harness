# Agent Note：Desktop 扩展中心属于 DSH 导航

状态：已实现

[English](2026-09-20-desktop-extension-center.md) | 中文

## 问题

作为独立 Slark 界面启动的扩展管理器无法继承已激活 DSH Profile 的生命周期。因此，它可能在不存在已验证 Profile 视图时请求 Host 扩展权限，产生 `dsh_profile_view_required`，同时形成与 DSH 无关的导航体验。

## 决策

扩展中心是 DSH 客户端插件。它在设置正上方贡献 footer action，并提供含插件、MCP 与技能标签页的 root 作用域 `main` 面板。Slark 菜单与快捷键跳转到同一面板，不再打开第二个窗口。

客户端贡献受能力闸门控制。专用、隔离的 Desktop 桥必须先为当前 Profile 完成带版本的 `hello()`，两个 slot 注册才会存在。桥只暴露明确的扩展方法与结构化结果码；不暴露 Electron IPC、Profile selector、凭据、文件系统路径或通用命令通道。权限缺失或拒绝时关闭失败。

选中面板时，会话保持挂载但隐藏。标签偏好按不透明 Profile key 隔离。Host 清单与后续修改事务留在 React 之外；DSH 页面只拥有呈现状态，并忽略过期的异步完成结果。

插件准备阶段对不可变的 npm 精确版本或 GitHub 精确提交清单执行零写读取。已识别的生命周期脚本及精确命令通过摘要绑定到计划。只有 Desktop 在二次确认中返回该摘要，脚本才会执行；Host 只把已审阅的精确 `package@version` 加入 Profile 构建策略。卸载、修复和未授权安装继续禁用脚本。

renderer 按 Profile 只保留最近一次不透明操作 UUID，并在重载后用它重新查询 Host 状态。Main 也独立于 renderer 监控已提交操作，只有 Host 报告成功后才重新打开当前 local、离线 Account 或在线 Account Profile。未知结果保持可见且绝不自动重放。更新流程接受精确旧来源，作为显式版本恢复。

## 考虑过的替代方案

**独立 Slark Hub。** 它让入口脱离 DSH 导航，也无法自然继承 DSH Profile 就绪状态。

**始终显示 DSH 导航，再展示不可用页面。** 这会在权限存在前宣传能力，只是把原始失败推迟到点击之后。

**通用 preload 桥。** 它让未来方法容易增加，却破坏了可审查的权限边界。

## 结果

浏览器托管的 DSH 部署不会出现扩展中心入口。Desktop 构建必须提供匹配的桥协议，本包才会可见。菜单路由、清单与修改事务汇聚到同一个 Profile 绑定界面，而 DSH slot 释放和 preload 监听移除提供一个可逆生命周期。
