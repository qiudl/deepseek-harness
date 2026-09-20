---
description: "DSH 原生扩展中心主面板与侧边栏入口；仅在受限的 Slark Desktop Profile 握手成功后显示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-extension-center

[English](README.md) | 中文

## 概述

扩展中心是 DSH 的导航目的地，包含插件、MCP 与技能。入口紧邻设置上方，打开 root 作用域的 DSH 主面板，不会替换或卸载当前会话。只有受限的 Slark Desktop 桥确认当前渲染器属于已激活的 DSH Profile 后，整组贡献才会出现。

## 目录

- [使用扩展中心](#use-the-extension-center)
- [理解边界](#understand-the-boundary)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-the-extension-center"></a>
## 使用扩展中心

在通过验证的 Slark Desktop DSH Profile 视图中，选择「设置」上方的「扩展中心」。面板默认打开「插件」，并按不透明 Profile key 分别记住上次选择的插件、MCP 或技能标签页。每个标签页都会懒读取当前清单，并展示加载、失败与重试、空结果及就绪状态。插件只接受 npm 精确版本或 GitHub 精确提交。准备阶段会在确认前展示全部生命周期脚本；同一表单也能更新到或显式恢复到另一个精确版本。

-----

<a id="understand-the-boundary"></a>
## 理解边界

<details>
<summary>实现细节——点击展开</summary>

本包只读取 `window.__SLARK_DSH_EXTENSIONS__`，不会回退到通用 Slark renderer API。激活时先调用 `hello()`，再注册两项贡献；桥不存在、Profile 被拒绝、协议不受支持或握手抛错时，主面板与侧边栏行都不会出现。成功握手只返回用于偏好隔离的不透明 key 与显示名称。

`main` keyed 贡献和 `sidebar.footer.action` list 贡献通过 `ctx.slots.inject()` 跟随各自拥有方。主进程菜单通过桥的 `onOpen()` 回调打开同一面板。所有注册与回调都会随插件 fiber 释放，包括释放与未完成握手发生竞争的情况。

清单读取绑定当前标签页；切换标签或卸载后会忽略过期完成结果。Local Storage 只在不透明 Profile key 下保存上次标签名和最近一次不透明操作 UUID，不保存 selector、凭据、包来源、脚本命令或 Host 权限。renderer 或 worker 重载后，UUID 用于重新连接 Host 持久回执。`unknown` 只提示人工核对，绝不自动重放。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-layout](../ui-layout/README.zh.md)——root 主面板选择与保留的会话状态。
- [ui-sidebar](../ui-sidebar/README.zh.md)——设置上方的 footer action 座位。
- [Slot 系统](../../../docs/subsystems/slots.zh.md)——贡献所有权与释放规则。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只贡献 Desktop UI，不发送面向模型的提示词或工具描述。

#### KV Cache 影响

无；它不组装提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 已支持插件安装、精确版本更新或恢复以及回执重连。MCP/Skill 修改控件和插件启停或移除控件仍延期；对应清单已可查看。
- 普通浏览器托管的 DSH 页面无法证明 Slark Desktop Profile 权限，因此刻意不显示扩展中心。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

桥是能力边界，不是传输便利层。扩展时应增加明确的方法与结果码；不要暴露 `ipcRenderer`、文件系统路径、Profile selector 或通用 invoke 函数。

</details>

**运行时不变式：** 没有成功的 Profile 握手，就不会注册扩展中心导航与面板。
