# @deepseek-ai/dsh-slark-collaboration-network

[English](README.md) | 中文

该 Cordis 插件把配置好的 DSH 正式 Agent 变为 Slark 协作调用的受围栏 worker。它由 `slark-cloud` bundle 挂载，且只有 `DSH_SLARK_COLLABORATION_V2=1` 时才启用。

每个 roster 项包含稳定 UUID、Agent preset，以及可选的专用 authority session ID。worker 从 `slarkIdentity` 获取短期 owner subject；subject token 永远不会进入插件配置、日志、prompt、URL 或 receipt。Slark 会把每次领取限制到该 owner、个人项目、环境、active binding 和精确的正式 Agent。

执行 session ID 由 project、connection、policy epoch 和正式 Agent 确定性生成。已有持久 session 使用其既有 preset 恢复；新 session 在发布前挂载配置的 preset。结果先投影到 envelope 明确指定的 Thread scope，再提交 terminal receipt。传输或执行结果不确定时绝不报告 success。

受信 Cordis 集成可以调用 `ctx.slarkCollaborationNetwork.dispatch()` 发起 DSH→Slark 调用。服务会先确认 envelope source 是已配置的正式 Agent，再使用最新 owner authority 提交。
已验证的 DSH 真人 session 可调用 `dispatchHuman()`；该路径必须同时提供 Edge 新签发的短期 actor assertion，Slark 会把 JWS、同一 subject session 与 active caller-target grant 绑定后才准入。
浏览器使用 DSH CSRF header 调用同源 Edge 的 `POST /api/slark/v1/collaboration/actor-assertions` 获取 assertion；Edge 从 HTTP session 派生 user、project、environment 与 session claims。受信集成只在内存中把返回的 JWS 转交 `dispatchHuman()`，不得持久化，也不得放入 URL 或 prompt。

## 模型体验

通过把已验证的 invocation 输入交给所选正式 Agent preset，间接影响模型。

#### KV Cache 影响

project session 会保留自己的对话历史；不同 project、connection、policy epoch 和正式 Agent 永远不会共享 session ID。

## 已知限制与后续工作

- v1 只接收有界文本输入；附件需要后续 content-reference 契约。
- roster 编写仍由部署配置管理。本包负责 worker 执行，不负责面向用户的 roster 编辑器。
