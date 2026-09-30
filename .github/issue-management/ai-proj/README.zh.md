# Fork ai-proj 门禁

[English](README.md) | 中文

`qiudl/deepseek-harness` fork 根据 ai-proj 项目 212 中已批准的需求校验 PR。其他仓库保留既有 Issue 与 Project 工作流。代码、覆盖率、产物和打包检查仍是独立的合并门禁。

## 引用与校验

PR 必须在 Markdown 注释和代码之外引用 `REQ-YYYYMMDD-NNNN` 及实施任务，例如 `Task 22610`。每个引用需求必须属于项目 212、保持已批准状态，并关联一个被引用且状态为 `in_progress`、`testing` 或 `completed` 的实施任务。每个引用任务必须满足至少一个引用需求的条件。缺失、歧义、不完整或失败的 API 响应均拒绝校验，包括草稿 PR。

校验器读取当前 PR 元数据，返回成功前再次检查提交与引用。工作流在已检查的提交上报告 `Issue policy` 和 `Issue lifecycle` 状态；生命周期状态审计相同的治理记录，不修改 ai-proj 审批或 GitHub Project 数据。

## 凭据与执行归属

将 `AI_PROJ_CI_READ_TOKEN` 配置为仓库 secret，使用仅能在 `https://ai.pipexerp.com` 读取项目 212 需求及关联任务的服务凭据。不得使用员工 Desktop token。凭据缺失时校验失败。请求具有 20 秒期限及 2 MiB 响应上限，拒绝重定向，错误消息不包含响应正文或凭据。

工作流使用 `pull_request_target`，只检出可信的仓库默认分支，并关闭 Git 凭据持久化。它在 Node 下直接运行校验器，不安装或执行 PR 代码。GitHub token 读取 PR 元数据并写提交状态，不修改 Issue 或 Project。手动调度接收一个已打开的 PR 编号，同样使用默认分支的校验器。

## 验证与启用

运行 `pnpm run test:issue-management`，覆盖既有上游规则、fork 校验器与工作流隔离测试。可信策略安装且服务 secret 配置后，在 GitHub 验证接受及拒绝场景；本地测试不能证明真实服务访问成功。历史 PR 基础分支必须继承策略工作流，才能替换原有的 fork Issue 任务。策略变更进入可信默认分支前必须经过评审。

引用：REQ-20260930-0005，ai-proj Task 22610。
