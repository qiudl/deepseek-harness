# Slark 工作区项目范围

REQ-20260930-0004，项目212，T21 /22661。可选协同区域编辑会话实际 DSH 工作区的 Slark 项目限制，与任务发送分开。工作区初始没有项目，未归属工作区的会话不继承范围。

范围模式关闭旧分配目录和旧调用入口。新项目范围不授权旧接口，而新版执行尚未接通；只过滤列表而保留旧调用，会让缓存芯片或另一 renderer 调用绕过新限制。只读目录直接说明这一限制，同时保留普通聊天和已有任务历史。

范围数据归属无 React 的会话投影，通过 slot 的 hooks 区域观察。工作区归属来自 Workspace Controller，未保存的选择属于组件私有状态；账号和 Native 权威保留在 Desktop Main。迟到读取不能恢复上一工作区或桥接身份的数据。保存使用当前权威版本，每次尝试后重新读取范围，不自动重放。

验证覆盖模型生命周期、续页、组件多选/应用/取消，以及使用 Desktop 传输 fixture 的构建 AppWebEntry 组合。Native 签名、Main HTTP 协调和受限 PostgreSQL 在 Slark 的专用集成测试中验证；Profile-worker 归属读取、daemon inspection、Slark 认证和 Electron IPC 在该组合中仍为外部 fixture，不构成安装包或生产验收。
