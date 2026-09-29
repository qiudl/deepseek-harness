# Slark Agent 提及

`ui-slark-agent` Client 插件在 Account Profile 在线时通过 Desktop Host 桥读取获分配的企业 Agent。每个 `@` 候选将分配、项目、Agent、企业和发布版本作为稳定的编辑器引用。同名 Agent 显示所属企业和项目。

在 staging 服务凭据与端到端验收就绪之前，Web bundle 中的插件条目保持禁用。以 Agent 芯片开头的纯文本问题会接管 Enter，经 Desktop Host 提交带幂等键的调用。引用的序列化器拒绝普通模型发送，避免已选 Agent 悄然变成提示词文本。Desktop 桥只提供安全目录摘要；Slark 在调用准入时仍需重新检查分配授权。

## 模型体验

会话任务区从 Slark 重新读取绑定当前账号的回执，在原会话显示答案，并在 120 秒后把未完成调用标记为后台任务。Slark 任务中心也列出同一持久调用。未被认领的普通 `@` 引用仍交给 DSH 模型输入。

此包不发布运行时 invariant：它只向既有输入触发器注册来源，不拥有独立的 Host 关系。
