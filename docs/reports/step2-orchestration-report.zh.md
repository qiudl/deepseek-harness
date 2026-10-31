# Step2 编排报告

[English](step2-orchestration-report.md) | 中文

提交标签对应的精确标识保存在 `~/coding/logs/step2-commit-identifiers.md`。

## 结果

Host 创建、客户端字段传递以及由 Agent 持有的模型选择实现已集成。完成仍受原始上游标签合并阻塞：`dsh-v0.2.2-alpha.2` 不是当前分支的祖先。各 worktree 保留提交，未推送任何分支。

## 子任务

| 任务 | 已集成提交 | 证据与限制 |
| --- | --- | --- |
| Host | `host-1`、`host-2`、`host-3` | 精确采用和新会话 claim 共享身份队列；报告工作区部分附加结果；后续 barrier 回归覆盖并发预设捕获。Host 控制与启动包仍予保留。 |
| 客户端 | `client-1`、`client-2` | 客户端传递 `agentPreset`、`exactAdopt` 和 `dedicatedCollaboration`，使用返回身份，并区分部分失败时已经附加的 Session。 |
| 模型 | `model-1`、`model-2`、`model-3`、`model-4`、`model-5`、`model-6`、`model-7` | 投影 v3 使用唯一 Agent 模型选择写入者；已适配 ACP turn pin、headless、Session 冷读取和 v2 缓存重建。持久 schema 确认通过。 |
| 集成 | 本分支上的合并提交；`integration-catalog` 更新合并后的持久化目录 | Host/客户端与模型冲突已联合解决；保留 `claims` 身份队列，删除旧选择 WeakMap，并重新生成双语配对记录。 |

## 验证

最终集成的针对性 Vitest 运行覆盖八个文件，235 项通过，涉及 Session 创建、模型选择、客户端 manager、Host 控制、Agent 和 ACP。Session controller Host TypeScript 构建、`verify-no-unknown-casts`、`verify-persistence-changes`、`verify-persistence-catalog`、`verify-cordis-catalog`、`verify-export-jsdoc` 和 `verify-upgrade-guides` 均通过。模型子分支还通过完整 Host 引用构建及针对性 ACP/headless 回归。

构建本机 native addon 并生成必需的被忽略 Typert Host 产物后，TypeScript SDK `multi-turn` 和 `model-switch-notice` 录制 Session 快照各通过一项。此前缺少这些产物的尝试失败；成功的重跑使用集成源码与本地重建产物。

CPython 3.13.13 的 macOS arm64 测试使用锁定的 `pydantic-core 2.46.5` wheel，其 SHA-256 与 `python/sdk/uv.lock` 一致。wheel 保存在 `tmp/step2-wheelhouse/`；默认 uv 缓存为 `~/.cache/uv`，测试环境为 `tmp/py-sdk-venv`。Python 包要求 3.10 及以上，发行版安装验证以 Python 3.10 为基线；打包可执行文件使用 Node 24。离线同步最初还缺少 `pytest 9.1.1`，联网补齐锁定测试依赖后执行以下验证：

- `UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --locked --offline pytest`：212 通过，10 跳过。
- `pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-macos-arm64 --artifacts-only`：成功生成本机打包 runtime；打包扫描输出模块缺失警告。
- `UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --locked --offline python scripts/smoke-python-runtime.py --scenario <scenario> --exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64`：`sdk-snapshot`（包含恢复场景）、`sdk-restart`、`sdk-minimal`、`sdk-minimal-in-history` 和 `sdk-dynamic-tools` 均通过，未更新快照。

提交标识保存到上述证据文件后，`pnpm run doc-sync` 的 43 项检查全部通过。

`pnpm --filter @deepseek-ai/dsh-subprocess-local pack --dry-run --json` 成功，清单包含 `lib/runner.js`、`lib/runner-launch-B2zsQ1Dz.js` 和 `scripts/ensure-spawn-helper.mjs`；此结果只覆盖本地构建产物的发布文件选择。

在 macOS 执行 `pnpm exec vitest run packages/subprocess/subprocess-local/tests/linux-scope.spec.ts packages/subprocess/subprocess-local/tests/linux-scope-selector.spec.ts packages/subprocess/subprocess-local/tests/native-containment.spec.ts`，99 项通过、5 项跳过，其中包括 Linux 原生隔离套件。Docker 无法连接守护进程，现有 Colima 虚拟机重置 SSH 连接，因此 Linux user-systemd 运行时验证仍待完成；Windows 打包验证已搁置。

## 剩余工作

将上游标签合并及其余包、构建、文档和版本策略冲突作为单独评审的工作完成；不能假定选择性集成的提交包含上游独有的 3,166 个提交。在最终合并树上重跑受影响检查，保留已发布 Session 代际且不承诺降级支持。

执行证据和各任务日志位于 `~/coding/logs/step2-orch-*.log`；SDK 诊断及离线依赖错误分别记录于 `step2-orch-sdk-validation.log` 和 `step2-orch-python-offline.log`。
