# Agent Note: Slark 插件目录与市场

[English](2026-08-30-slark-plugin-catalog-market.md) | 中文

Status: proposed

## Problem

DeepSeek Harness 可以安装 profile bundle，但用户必须预先知道 package 或 repository 标识。社区目录是由多个贡献者控制的外部 YAML；若直接载入模型或浏览器，就会把未验证数据混入产品证据，也无法区分失败刷新和当前结果。

## Proposal

Slark cloud bundle 挂载只读插件目录消费方。目录包把一个完整上游 Git revision 验证为不可变、确定性排序的条目，并原子发布。自然语言发现只产生受限查询意图，每个返回标识和展示事实都来自同一目录 revision。

目录通过 Host 能力缝 `ctx.pluginCatalog` 暴露。面向模型的消费方只注册一个只读 `plugin_search` 工具，拒绝未声明的意图字段，并使用服务当前快照执行已接受的意图。模型不会直接返回目录条目或来源定位符。

目录收录与来源验证、安全审核保持分离。只读里程碑不公开任何 profile 修改操作。安装属于后续能力，使用独立的可信确认和执行进程。

## Alternatives considered

**原样安装现有 dsh-market bundle。** 它不负责 Slark 身份、不可变 revision 证据、stale 状态呈现或可信安装协议，因此无法建立所需产品保证。

**让模型直接搜索 GitHub。** GitHub topic 不能证明 `dsh.bundle` 兼容性，模型生成的 package 标识也可能不在已评审目录中。

**在浏览器中解析条目。** 这会在多个客户端重复验证，并允许单个畸形或超大刷新消耗 renderer 资源。Host 负责验证并发布一份有界快照。

## Acceptance criteria

- 畸形、超大、重复或身份不匹配的源文件会拒绝整次刷新，并保留上一份成功快照。
- 条目身份和 revision 不受源文件顺序影响。
- 搜索结果属于一个显式 revision 的子集，并使用确定性次排序。
- 只读里程碑没有 profile 写入或插件管理命令路径。

## Risks

目录用户可能把验证误认为背书。UI 文案必须把条目标为目录候选，只能在独立流程产生证据后使用来源验证或安全审核标签。
