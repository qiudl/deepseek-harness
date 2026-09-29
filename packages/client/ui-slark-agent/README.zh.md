# Slark Agent 提及

`ui-slark-agent` Client 插件在 Account Profile 在线时通过 Desktop Host 桥读取获分配的企业 Agent。每个 `@` 候选将分配、项目、Agent、企业和发布版本作为稳定的编辑器引用。同名 Agent 显示所属企业和项目。

在员工调用准入和结果回填完成之前，Web bundle 中的插件条目保持禁用。引用的序列化器拒绝普通模型发送，避免已选 Agent 悄然变成提示词文本。Desktop 桥只提供安全目录摘要；Slark 在调用准入时仍需重新检查分配授权。

## 模型体验

当前选择 Agent 不会向 DSH 模型发送文本。后续调用路径必须将员工问题与选中的稳定引用关联，并把回执返回原会话。普通 DSH 模型不能用 Agent 引用文本代替调用。

此包不发布运行时 invariant：它只向既有输入触发器注册来源，不拥有独立的 Host 关系。
