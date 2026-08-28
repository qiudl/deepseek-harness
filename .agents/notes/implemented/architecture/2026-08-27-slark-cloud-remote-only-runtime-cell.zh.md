# Agent Note：Slark 云端 Runtime Cell 是纯远程执行平面

Status: implemented

[English](2026-08-27-slark-cloud-remote-only-runtime-cell.md) | 中文

## 问题

Slark 在云端 Web 界面中把 DeepSeek Harness 作为个人工作台提供给用户，但真正要操作的文件与 Shell 仍位于用户选中的 Desktop 设备。普通 DSH Web profile 按设计拥有本地文件系统、subprocess、sandbox 与 Shell Provider。若原样复用该 profile，设备连接缺失时，操作可能悄然转为在云端 Runtime Cell 中执行；该 Cell 既不是用户电脑，也不是已授权 workspace。

身份存在同样的边界问题。云进程每次远程操作都需要短期 Slark subject，以及准确的 Device、Workspace Grant、generation 与 epoch 围栏，但这些事实不得进入模型提示词、session log、浏览器存储，也不能放进可能跨 session 的进程级可变单例。

Agent preset 也是执行约定的一部分。若独立版 DSH 显示云端专用 preset，其“经 Desktop 中转”标签就是错误的，因为该部署按设计保留本地 Provider。只隐藏 UI 控件无法阻止 API、已保存设置或其他入口选择错误组合。

## 决策

`slark-cloud` bundle 是叠加在 base 与 Web 层之后的宿主平面 Provider 替换层。它硬禁用所有 Cell 本地执行 Provider，并在同一个精确 feature switch 后挂载 Device client、身份适配器、远程文件系统与远程 Shell。关闭开关会同时禁用四条远程配置行，不恢复任何本地能力，因此不可用的灰度会以关闭能力的方式失败。

Slark Edge 原子替换一份私有 authority 文件。`dsh-slark-identity` 在每次 Provider 操作时打开并校验该文件，检查 Cell 组合中固定的 workspace handle，并通过 `AsyncLocalStorage` 把 authority 绑定到 DSH Session。受信工具执行与 agent pre-step 事件建立作用域；受信直接调用方必须显式建立作用域。任何 authority 事实都不进入 agent 平面。

云端 Agent preset 只包含与 Provider 无关的 agent 能力，以及由远程文件系统或 Shell seam 支撑的工具。依赖 subprocess 的搜索、持久 terminal、LSP、hook、目录选择以及 Cordis／插件创作均不在其中。profile 同时禁用用户 preset 发现与 preset 切换。

CLI 把云端 preset 放在独立的随附根目录。只有组合后的 profile 含 Slark Device Provider 配置行时才选择该根目录，即使共享开关正禁用该配置行也是如此。独立版 profile 继续只发现普通随附根目录，因此既保留本地 Provider，也不会暴露含义错误的云端 preset。

Slark 云端客户端构建设置 `DSH_CLIENT_SLARK_WORKBENCH=1`。部署品牌浏览器插件据此占用 `sidebar.footer.action`，显示一个“企业工作台”链接。其精确的 `slark-workbench://switch/slark` 顶层导航由 Slark Desktop 的隔离 DSH view 接收，并在该白名单之外被拒绝；独立浏览器构建不会渲染该操作。

首发版本中，一次 Runtime Cell 组合固定一个 workspace handle。选择其他 Workspace Grant 时创建或重新组合 Cell，不在活跃 Provider 边界内直接修改。

## 考虑过的替代方案

**让浏览器调用 Desktop 的 localhost 服务。** 不采用，因为浏览器安全策略、origin 信任、端口发现与企业代理会使 localhost 可达性不稳定；由 Desktop 认证的出站通道则让 Slark 在 macOS 和 Windows 上共用同一条受控路径。

**设备离线时保留本地 Provider 作为回退。** 不采用，因为在错误执行环境中成功执行比明确不可用更危险。本地 Provider 在独立版 DSH 中仍然正确，只在 Slark 云部署中刻意缺席。

**通过环境变量传入一个 subject token，或在进程范围缓存。** 不采用，因为轮换、并发 session 与重新 assignment 会使缓存 authority 过期或跨越租户边界。Edge 持有的文件可替换且不会把 token 放进命令参数；逐操作校验让撤销与 generation 围栏保持最新。

**只在 Web UI 隐藏本地工具与 preset 控件。** 不采用，因为模型工具、API 调用、已保存设置及非浏览器入口仍可访问宿主组合。边界由 Provider 配置行和发现根目录执行，而不是由展示层执行。

**只依赖 Desktop 键盘快捷键返回。** 不采用，因为隐藏的逃生路径无法让两个可见工作台形成统一产品体验。快捷键保留为恢复路径，侧边栏操作承担可发现的返回入口。

## 后果

Slark 云端 session 要么在当前 Workspace Grant 下访问选定 Device，要么明确失败；绝不会针对 Runtime Cell 的文件系统或 Shell 执行。关闭灰度开关是安全的，但会有意移除新 agent 组合的文件与 Shell 能力。

authority 文件发布、Device 连通性与 Grant 生命周期成为部署健康信号。首发版本切换 workspace 需要重新组合 Cell。远程搜索暂时没有专用 Provider，因此需要搜索时由 agent 使用有界远程 Shell 命令。

独立版 DSH 行为不变：现有 preset 与本地 Provider 继续可用，其中无法发现 Slark 云端 preset，侧边栏也没有 Slark 返回操作。
