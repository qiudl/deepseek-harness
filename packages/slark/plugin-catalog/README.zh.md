# `@deepseek-ai/dsh-plugin-catalog`

[English](README.md) | 中文

为 Slark Runtime Cell 提供经过验证的 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 目录快照。此包在发布前解析完整 revision；刷新失败时保留上一份快照不变。

## 快照输入

`buildCatalogSnapshot()` 接收一个 40 字符 Git commit、一个有效生成时间和完整 YAML 源文件集合。单份快照最多接受 20,000 个 `.yml` 文件，每个文件不超过 8 KiB，总量不超过 32 MiB。YAML alias、merge key、重复 key、未知字段、控制字符、双向控制字符、重复仓库以及无效的 GitHub 仓库路径都会使整次刷新失败。

每个规范化条目公开稳定的 `entryId`、ASCII `ownerName`、精确 HTTPS GitHub 仓库、分类、纯文本中英文描述、可选的声明 tarball URL、可选且经仓库校验的包名，以及 `catalog_candidate` 可安装状态。被目录收录不代表经过安全审核；消费方必须展示这一区别，并在任何写操作前重新验证安装来源。

## 发布

`CatalogSnapshotStore.refresh()` 先验证并构造完整不可变值，再替换 `current()`。revision 是 source commit 与规范排序条目的 SHA-256，因此输入文件顺序不会改变身份。生成时间用于表达新鲜度，但不参与 revision。

## 查询

`queryCatalog()` 对一份指定快照应用自然语言词元、分类、来源类型和安装状态筛选。搜索会从请求中提取规范化单词和中文二元组，再对 owner 名称与纯文本说明中的命中计分；同分结果使用 owner/name 和条目身份作为确定性次排序。opaque cursor 把 offset 绑定到快照 revision，跨 revision 复用会失败。超过 24 小时的结果携带 `stale: true`，同时保留真实生成时间。

## 模型体验

无。此包只验证目录数据；独立消费方决定条目是否以及如何进入模型请求。

#### KV Cache 影响

无直接影响。此包不会把快照刷新内容加入模型请求。

## 已知限制与延后工作

- **仅用于发现的身份** — 第一版目录接受 GitHub 仓库、GitHub 托管的声明 tarball，以及用于 inventory 匹配且经仓库校验的 npm 包名。安装来源验证由安装协调器负责。
