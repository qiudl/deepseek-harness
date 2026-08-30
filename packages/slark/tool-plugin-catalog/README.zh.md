# @deepseek-ai/dsh-tool-plugin-catalog

[English](README.md) | 中文

面向模型的只读插件发现能力，消费 `ctx.pluginCatalog`。`plugin_search` 只接受受限的结构化查询意图，并从当前已验证目录 revision 返回条目；它不能安装、执行或生成插件来源。

工具会在查询服务前拒绝未声明的意图字段。返回 JSON 包含 `revision`、`generatedAt`、`stale`、匹配条目和绑定 revision 的不透明游标。被目录收录不代表通过安全审核。

## 模型体验

### 工具 schema

模型看到一个 `plugin_search` 工具，可选字段包括关键词、分类、来源类型、排序、游标和数量限制。工具可见期间，固定 schema 只增加少量稳定前缀成本。

### 工具调用历史和结果

查询意图会保留在工具调用历史中。结果是完全来自 `ctx.pluginCatalog` 的紧凑 JSON，Token 成本随受限页大小增长。只要插件组合不变，稳定工具定义可继续复用 KV Cache。

## 已知限制与延后工作

- 自然语言质量取决于当前模型能否选择有效的结构化筛选条件；这里不使用第二个意图模型。
- M1 只读。安装必须使用另行评审的可信确认与 Cell Installer 协议。
- 已安装状态筛选保留在可信 Host Gateway，模型输入有意不提供该字段。
