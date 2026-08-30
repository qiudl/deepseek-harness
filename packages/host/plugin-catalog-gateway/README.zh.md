# `@deepseek-ai/dsh-host-plugin-catalog-gateway`

[English](README.md) | 中文

面向插件市场客户端的只读 Cordis Remote Gateway。它投影当前 `pluginCatalog` 版本，并根据已配置的 Cordis Loader 模块名与目录校验后的包名映射计算已安装状态。客户端不能提交 installed entry ID。

## 模型体验

无。Gateway 服务可信浏览器客户端；面向模型的工具是另一个 Cordis 插件。

## 已知限制与后续工作

- 没有可信包名映射的条目不能被报告为已安装。
