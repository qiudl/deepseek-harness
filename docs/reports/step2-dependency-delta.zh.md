# Step2 依赖变更清单

[English](step2-dependency-delta.md) | 中文

第一个依赖检查点为拟议的 Agent 自有模型投影，将 Agent 包依赖与 `dsh-v0.2.2-alpha.2` 对齐。fork 的现有依赖均予保留。锁文件离线重新生成；没有修改任何包的 version 字段。

| 变更 | 包 | 依赖 | 原值 | 结果 | 原因 |
| --- | --- | --- | --- | --- | --- |
| 新增 | `packages/core/agent` | `@deepseek-ai/dsh-brand` | 无 | `workspace:*`，链接至 `packages/util/brand` | 上游 Agent 投影导入品牌类型辅助函数。 |
| 新增 | `packages/core/agent` | `zod` | 无 | `4.4.3` | 上游 Agent 模型选择投影使用 Zod 校验状态。 |

没有升级、降级或删除依赖。Zod 4.4.3 已存在于锁文件，本次仅增加包导入引用，没有引入新的包版本。后续依赖变更须分别记录清单并验证。
