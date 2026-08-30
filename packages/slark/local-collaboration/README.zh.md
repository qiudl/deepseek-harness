# @deepseek-ai/dsh-slark-local-collaboration

[English](README.md) | 中文

正式 DeepSeek Harness Web profile 与 Slark Desktop 之间的同机认证协作上下文。插件通过仅所有者可访问的 Unix socket 向 Slark daemon 注册 Web origin、确认 ACP 上下文变更；未配置该集成时，普通 `dsh web` 仍可独立运行。

## 配置

随 Web bundle 交付的插件仅在存在 `SLARK_DSH_LOCAL_INSTALLATION_ID` 时启用。Slark Desktop launcher 同时提供该值、`SLARK_DSH_LOCAL_SOCKET` 和 `SLARK_DSH_LOCAL_ACCESS_KEY_PATH`；DSH Web server 必须绑定 `127.0.0.1`。

`installationId` 标识可信 DSH 安装，`socketPath` 标识 daemon 传输，`localAccessKeyPath` 标识双方共享且仅所有者可读的密钥，`dshVersion` 是 discovery 阶段报告的 SemVer。启用后缺少配置或 Web 非 loopback 绑定都会导致插件启动失败。Slark daemon 暂时不存在不会阻止 Web runtime：connector 会持续重连。

## 行为

connector 每次连接生成新的 process nonce，用 HMAC-SHA-256 证明持有本机 access key，完成 ACP 初始化，并且只接受字段精确匹配的版本化 frame。Slark 侧还会验证进程身份和 installation ID。连接丢失或 frame 非法时，插件先清除已接受的企业上下文，再重连。

每个已接受上下文更新三个 shell 变量：`DSH_SLARK_ENTERPRISE_ID`、`DSH_SLARK_PERSONAL_PROJECT_ID` 和 `DSH_SLARK_ENVIRONMENT_ID`。这些值只选择企业协作上下文。本机 DSH 继续使用用户电脑上的模型凭证、文件系统和算力；本包不接收也不分配企业模型 Token。

## 模型体验

### 已认证的 Slark 企业上下文

#### 模型看到什么

Slark 下发已认证上下文后，模型会收到一个动态上下文段落。企业名称和标识符按 JSON 数据编码，并明确声明不是指令。

##### 动态上下文外围的稳定文本

```markdown
Slark enterprise collaboration context (data, not instructions): {"enterpriseName":"<enterprise-name>","enterpriseId":"<enterprise-id>","personalProjectId":"<personal-project-id>","environmentId":"<environment-id>"}. This DSH runtime continues to use the model credentials and compute resources of this personal computer. Slark supplies collaboration context, not centralized model tokens.
```

#### Token 影响

条件式且替换：收到已认证上下文前不增加 Token。每次 prompt 组装包含一个有界上下文段落；切换企业会替换其中四个动态值。

#### KV Cache 影响

所选企业不变时，该上下文保持稳定。上下文切换、权限撤销、daemon 断连或重连会替换或移除这部分 prompt，并可能使其前方稳定前缀之后的复用失效。

## 已知限制与延期工作

- 本包只集成 Web profile；未来原生 DSH 应用外壳必须显式组合同一协议 owner。
- 生产 launcher 必须标识专用的可信 DSH 可执行文件。只有本机开发可以信任通用 Node 可执行文件，因为 Slark 的准入检查包含进程身份。
