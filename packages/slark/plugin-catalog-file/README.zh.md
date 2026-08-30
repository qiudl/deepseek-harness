# `@deepseek-ai/dsh-plugin-catalog-file`

[English](README.md) | 中文

`pluginCatalog` 的 Cordis 文件系统 Provider。它读取部署方持有的绝对 manifest，验证每个 YAML 文件且禁止路径逃逸，将生成内容与 manifest 固定的 `expectedRevision` 校验一致后，再原子发布完整快照。

同目录必需的 `plugins.json` registry 只补充 npm 包名，用于准确筛选已安装状态。仓库 URL 必须与已接受的 YAML 条目一致；映射不会让条目自动可信，也不会执行安装。registry 缺失或映射不一致时会拒绝启动，而不是发布误导性的已安装状态。

## 模型体验

无。该 Provider 不注册模型工具。

## 已知限制与后续工作

- 当前只在 Cordis 插件启动时刷新；部署系统发布新的不可变目录后重启所属 Cell。
