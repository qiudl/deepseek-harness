---
description: "当前 Desktop bridge 确认就绪后，从 DSH 导航打开 Slark 原有 Desktop Hub。"
kind: "package-reference"
---
# DSH 扩展中心入口

[English](README.md) | 中文

## 概述

从 DSH 侧边栏打开 Slark 原有 Desktop Hub。只有 Desktop bridge 确认当前 DSH Profile 可用后，入口才显示在“设置”正上方。原有 Hub 的内容保持不变；插件生命周期与配置仍由 DSH 官方“插件”页面负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Desktop Web bundle 会挂载本包的 Client 入口，无需额外配置。Desktop bridge 验证成功后，点击“设置”上方的“扩展中心”即可打开原有 Hub。bridge 不可用或就绪握手失败时，入口不会显示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client 入口仅在 `hello()` 返回受支持的 bridge 协议后注册本地化的侧边栏和面板 slot。点击入口时会选中承载面板并请求 bridge 显示 Hub；打开失败时清除选中状态。插件释放时移除两个 slot 和 bridge 监听器。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，因为此浏览器导航包不注册面向模型的输入或工具。

#### KV Cache 影响

无；此包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

入口依赖 Slark Desktop bridge，在独立的 DSH 浏览器会话中不可用。插件安装、启停和配置仍由 DSH 官方“插件”页面负责。

- **仅限 Desktop**——bridge 不存在或就绪握手失败时，导航入口保持隐藏。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
