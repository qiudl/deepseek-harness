# @deepseek-ai/dsh-web-frontend

[English](README.md) | 中文

此应用构建 DSH Web Client 的浏览器入口。受支持的 Node 启动器为 [`dsh web`](../cli/README.zh.md)；构建此静态应用不会启动 Host 或创建 Profile。

## Slark 远程载体

独立的 `remote-bootstrap` 构建入口将隔离页面连接到 Slark 父页面。`VITE_DSH_REMOTE_PARENT_ORIGIN` 必须为父页面准确的 HTTPS origin。载体只接受来自该父窗口、origin 且携带原 nonce 的一个 MessagePort。经过认证的 Host 启动字节和 Client bundle 均由该端口传入。

远端入口在 Client 插件启动前，为普通请求和暂存文件上传安装同一个已认证 Fetch 载体。隔离页面不能直接通过浏览器网络上传文件。

Client 插件应用前，载体通过端口读取 `/__collaboration__`。父页面声明 `dsh-remote-collaboration/v1` 且方法仅为 `workspace` 时，安装范围桥。能力元数据缺失、无效、未知或超时时，不安装此桥，普通远程聊天仍可用。不支持协同的父页面可以用 HTTP404 回应能力发现，并继续提供经过认证的启动数据。五秒发现期限也覆盖响应体读取。

范围桥只将已捕获的工作区、会话坐标和一个 `get`、`apply`、`projects` 或 `agents` 操作转发给父页面的 `collaboration/workspace` RPC。它检查 RPC 身份、嵌套结果、工作区、范围版本和目录字段，不携带账户凭据或可选电脑身份，也不使用浏览器网络 fetch。请求最多32 KiB，完整响应最多256 KiB。三十秒操作期限覆盖响应体读取。已发出的保存失败后需要重新读取，因为取消不能确定保存是否已提交。页面退出会取消正在处理的工作并移除自身的桥，迟到的能力发现不能安装它。

仅支持范围的父页面不暴露执行方法。父页面准确声明 `workspace`、`submit`、`pending` 和 `deliveries` 四个方法时，还会安装原始 Source 提交与状态、结果读取方法。这些调用使用同一认证端口、捕获的原始坐标、38 秒期限以及最多800 KiB 的响应数据。提交必须包含明确的 Agent 提及；坐标变化、身份注入和无效 RPC 信封均被拒绝。发送后的取消保留不确定状态，不自动重新提交。父页面校验完整结果投影与持久化投递；Client 插件校验并显示原消息分组。普通任务分配使用聊天中的明确 Agent 提及。父页面声明执行能力前必须提供所属运行时的原始 Source 列表；仅支持范围不代表 Agent 执行验收通过。

父页面还可分别声明 `conversations` 和 `archive`。`archive` 只接受工作区 ID、会话 ID 以及“归档”或“恢复”动作。父页面经加密的 Daemon 连接转发动作；Daemon 持有持久令牌、当前 Account 租约、Native 阶段证明和云端挑战。子页面不会取得令牌或证明。结果不确定时，可沿原 Native 意图重试。

## 验证

[远程载体测试](tests/remote-boot.spec.ts) 覆盖认证握手和安装顺序。[范围消费者测试](tests/remote-collaboration.spec.ts) 使用真实 WorkerTunnel 和 MessagePort，覆盖拒绝、取消和期限。这些隔离测试不代表真实 Account、provider 或独立 Agent 执行验收通过。

插件安装浏览器测试在高亮卡片不可见时记录卡片、高亮变化和浏览器时间戳。它保留可见性检查的超时，并重新抛出原始错误。

## 原生移动输入能力

REQ-20261018-0001 在协作能力发现之外增加可选 `/__native_workbench__`。仅精确的 `dsh-native-workbench/v1` 响应可声明 Duet 或草稿支持。Carrier 在 Client 插件加载前安装独立的 `__DSH_NATIVE_WORKBENCH__` 能力对象；不支持的父页面维持原浏览器行为。原生通话仅发送当前 Session ID，不发送账号、电脑、音频或凭据。草稿读写沿用现有 revision/text 契约。请求和响应严格校验，正文有上限并设置超时；页面销毁中止待处理操作，移除自己的能力对象，不会结束已经接受的原生通话。

## 随 App 打包的 Web 入口

Host 和 Client 库构建后运行 `pnpm --filter @deepseek-ai/dsh-web-frontend exec vite build --config vite.native.config.ts --mode native`。`dist-native/native.html` 内联同一个 Web shell、CSS、字体和延迟语言模块。签名 App 只复制此 HTML，Git 忽略生成目录。App 以 `sandbox="allow-scripts"` 的 `srcdoc` 嵌入，不授予同源访问。专用构建仅接收自身不透明父窗口发来的、绑定随机 nonce 的 MessagePort，校验父窗口提供的 HTTPS 资源命名空间，并仅将该地址用于隧道请求。普通 HTTPS remote 构建保留精确的配置 origin 检查。

文档允许现有 Cordis 表达式编译器需要的 `unsafe-eval`，与隔离生产 carrier 一致，网络访问仍禁止。单个内联入口绑定 SHA-256，已验证插件脚本使用 Blob URL。浏览器偏好使用有容量限制的 frame 内存；私有历史和草稿的持久化由原生加密桥负责。`node apps/web/tests/native-built.mjs` 在真实隔离浏览器 frame 中测试实际产物，覆盖 CSP 执行、WebCrypto、内存存储和第一条 Host 请求。该启动冒烟不代表离线历史或真实 Host 验收已完成。
