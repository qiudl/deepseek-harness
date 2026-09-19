# Agent Note: Desktop 个人模型文本调用

Status: implemented

[English](2026-09-19-desktop-personal-model-text.md) | 中文

## 问题

Slark Desktop 需要一个简单入口，使用本机 DSH Profile 已维护的模型和 API Key。如果将凭据复制进 Slark，或让个人输入经过 Slark daemon，就会增加凭据保管方，并使 DSH 的可用性依赖该 daemon。

## 决策

Desktop Main 为每次请求打开独立的认证 Host 连接。新的 Account 证明授权该连接访问在线 Account Profile；Host 在 `profile.model_text` 生成前后检查授权，连接关闭时取消调用。它不打开视图租约：第二个视图租约会推进 Profile 代际，使正在显示的 DSH 页面失效。Profile worker 读取当前默认模型和凭据服务，不启用工具或 Session，仅执行一次有长度限制的文本生成，返回提供方、模型和回答文本。随机且由 Host 持有的令牌授权 worker 的私有本机接口；浏览器不会得到该令牌。

## 已考虑的替代方案

共用可见 Profile 视图的连接会让取消请求影响用户正在看的 DSH 页面；打开第二个视图租约会使原视图代际失效。通过浏览器会话调用 worker 会使浏览器内容能够访问模型请求。在 Slark 另存 API Key 则需要重复管理凭据生命周期和撤销规则。

## 结果

该入口需要在线 Account Profile 和已配置的默认模型。每次请求输入最多 8 KiB，回答最多 16 KiB，worker 最长运行 60 秒。提供方原始错误和凭据值留在 Profile worker 内。协议、worker 接口、Host 授权与取消均有针对性测试。
