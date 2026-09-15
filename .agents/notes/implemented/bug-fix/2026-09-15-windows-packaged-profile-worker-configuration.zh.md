# Agent Note: 通过私有管道传递打包 Windows Profile 配置

Status: implemented

[English](2026-09-15-windows-packaged-profile-worker-configuration.md) | 中文

## 问题

Windows 包激活可能丢弃打包进程之间由调用方提供的环境值。因此，只通过 `spawn(..., { env })` 配置 `dsh web` 的 Store 安装版 Desktop Host，可能启动一个缺少主目录、Profile 身份、credential handle 或 plugin root 的 Profile worker。转发 ambient environment 还会暴露无关凭据，而 argv 和持久文件不适合承载 opaque credential handle。

## 决策

`DshWebProfileWorkerFactory` 在 Windows 上使用固定的 Node bootstrap。父进程序列化一个有版本且不超过 64 KiB、只包含明确 Profile 环境的记录，通过继承的文件描述符 3 发送，然后关闭该描述符。子进程校验完整记录与字符串字段，清除所有 ambient environment 值，写入明确值，再导入固定 DSH entrypoint。普通 stdin 保持关闭，DSH CLI 原有的 `--profile web` 参数不变。

父进程在 spawn 前拒绝超限记录。缺少配置描述符会拒绝启动，管道错误会终止子进程。非 Windows worker 保留直接传入明确环境的启动方式。

## 考虑过的替代方案

**继续使用 `spawn` 环境值。** 未采用，因为实际观察到包激活会在子进程读取前移除这些值。

**把完整记录放入 argv。** 未采用，因为进程检查会暴露 Profile credential handle 和插件配置。

**写入临时配置文件。** 未采用，因为新增持久路径与清理生命周期会带来泄露和替换风险，而继承的私有管道不会。

## 影响

Windows Profile 启动不再依赖自定义环境继承，同时仍不暴露 ambient 凭据。专用描述符只在 bootstrap 期间额外占用一个继承管道。真实子进程测试覆盖直接启动与 Windows 管道启动，要求明确 Profile 值存在、拒绝 ambient secret 继承，并完成已认证 loopback bootstrap 交换。
