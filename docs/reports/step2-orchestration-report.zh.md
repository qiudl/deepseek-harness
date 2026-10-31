# Step2 编排报告

[English](step2-orchestration-report.md) | 中文

提交标签对应的精确标识保存在 `~/coding/logs/step2-commit-identifiers.md`。

## 结果

Host 创建、客户端字段传递以及由 Agent 持有的模型选择实现已集成。本地 pin 分支正在合并 `dsh-v0.2.2-alpha.2`；冲突已解决，合并提交仍等待其余检查。未推送任何分支。

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

## Pin 分支验证

进行中的合并保留了内部 Host control client、Host startup 和 subprocess-local 安装 allowlist。`pnpm run build:artifacts` 的八个阶段全部通过，`pnpm run build:check` 的 Host 和 Client 两项聚合检查通过，重建产物后的 `pnpm exec vitest run packages/experimental/webworker-packer/tests/image-loadable.spec.ts` 通过 15 项。

`pnpm exec vitest run packages/subprocess/subprocess-local/tests/control.spec.ts packages/host/desktop-host/tests/startup.spec.ts packages/host/desktop-host/tests/startup-safety.spec.ts packages/host/desktop-host/tests/startup-composition.spec.ts packages/host/desktop-host/tests/host-control-authority.spec.ts packages/host/desktop-host/tests/host-control-session.spec.ts packages/host/desktop-host/tests/unix-transport-client.spec.ts packages/host/desktop-host/tests/unix-transport-server-faults.spec.ts packages/host/desktop-host/tests/unix-transport-authority-faults.spec.ts` 通过 84 项。

`pnpm exec vitest run packages/host/desktop-host/tests/client-artifact.spec.ts packages/host/desktop-host/tests/startup-platform.spec.ts packages/host/desktop-host/tests/collaboration-worker-process.spec.ts packages/subprocess/subprocess-local/tests` 通过 437 项、跳过 16 项平台相关测试。完整单测在发现失败后中止；输入和销毁相关失败修复后的针对性回归通过。Slark 字典现已补入日语、西班牙语、法语、德语、俄语和葡萄牙语各 238 条经校对的文案。`pnpm exec vitest run scripts/locale-dictionary-parity.spec.ts` 两项测试通过；`node node_modules/typescript/bin/tsc -b packages/client/ui-slark-agent/tsconfig.json --pretty false` 通过。

合并树的 Python SDK 测试组新增锁定依赖 `pillow==12.3.0`，已将其 macOS arm64 wheel 下载到 uv 缓存。`UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --group test --locked --offline pytest` 通过 251 项、跳过 3 项。打包启动测试遵循上游策略：可选插件不可用时，初始化成功并输出包含插件名的告警。

`pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-macos-arm64 --skip-build` 使用已验证的本地产物重建 macOS runtime；打包扫描报告未解析模块警告。`UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv" uv run --project python/sdk --group test --locked --offline python scripts/smoke-python-runtime.py --scenario <scenario> --exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64` 的 `sdk-snapshot`、`sdk-restart`、`sdk-minimal`、`sdk-minimal-in-history` 和 `sdk-dynamic-tools` 均通过，未更新快照。

`pnpm exec vitest run packages/api/session-controller/tests` 在进行中的合并树上通过 72 个文件、1674 项测试。

`pnpm exec vitest run packages/client/ui-conversation/tests packages/client/ui-chat/tests packages/client/ui-sidebar/tests packages/client/ui-slark-agent/tests` 在更新引用草稿测试以适配分离发送后，通过 148 个文件、2643 项测试。

直接使用 `classifyPersistenceChange`，将 `2026-10-11-slark-alpha2-integration` 和 `2026-10-13-liveshare-share-viewer-principal` 的四个共同事件根与 `docs/persistence-schema.json` 比较。相对 fork 快照，分类结果为上游可选 principal、skill-catalog 字段以及 action-cards attribution；相对上游快照，结果为 collaboration-result attribution。这些分类均未要求额外兼容性复核。显式双父确认记录 `2026-10-31-upstream-fork-merge` 保留双方已提交记录；`pnpm run verify-persistence-changes` 通过，覆盖 65 个根和 22 条记录，持久化历史测试文件通过 85 项。

在进行中的合并树上，`pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t multi-turn` 和 `pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t model-switch-notice` 各通过所选的录制会话用例。

历史合流后，`pnpm run doc-sync` 的 43 项检查全部通过，`pnpm run lint` 通过，并在实验性 CoT 翻译包中报告一条未使用抑制指令的警告。之后的 `pnpm run build:check` 通过 Host 和 Client 聚合检查。

首轮完整 `pnpm run test` 结果为 55,131 项通过、12 项失败、1 项预期失败、258 项跳过。修复后的发布工作流、桌面 MCP、持久化、工作区、悬停样式和打包配置等针对性测试通过；第二轮完整单测通过 55,142 项，另有一项真实 Git/pnpm 测试超时；将该测试超时从 5 秒调整到 30 秒后单独重跑通过，第三轮完整 `pnpm run test` 通过：55,143 项通过、1 项预期失败、258 项跳过。

## 剩余工作

生成验证通过的合并提交后，单独更新 qiu-slark 的 config、ref 和 SHA。

执行证据和各任务日志位于 `~/coding/logs/step2-orch-*.log`；SDK 诊断及离线依赖错误分别记录于 `step2-orch-sdk-validation.log` 和 `step2-orch-python-offline.log`。
