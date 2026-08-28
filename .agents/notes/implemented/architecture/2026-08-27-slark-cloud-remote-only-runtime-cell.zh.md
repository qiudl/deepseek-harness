# Agent Note：Slark 云端 Runtime Cell 是纯远程执行平面

Status: implemented

[English](2026-08-27-slark-cloud-remote-only-runtime-cell.md) | 中文

## 问题

Slark 在云端 Web 界面中把 DeepSeek Harness 作为个人工作台提供给用户，但真正要操作的文件与 Shell 仍位于用户选中的 Desktop 设备。普通 DSH Web profile 按设计拥有本地文件系统、subprocess、sandbox 与 Shell Provider。若原样复用该 profile，设备连接缺失时，操作可能悄然转为在云端 Runtime Cell 中执行；该 Cell 既不是用户电脑，也不是已授权 workspace。

身份存在同样的边界问题。云进程每次远程操作都需要短期 Slark subject，以及准确的 Device、Workspace Grant、generation 与 epoch 围栏，但这些事实不得进入模型提示词、session log、浏览器存储，也不能放进可能跨 session 的进程级可变单例。

Agent preset 也是执行约定的一部分。若独立版 DSH 显示云端专用 preset，其“经 Desktop 中转”标签就是错误的，因为该部署按设计保留本地 Provider。只隐藏 UI 控件无法阻止 API、已保存设置或其他入口选择错误组合。

## 决策

`slark-cloud` bundle 是叠加在 base 与 Web 层之后的宿主平面 Provider 替换层。它硬禁用所有 Cell 本地执行 Provider，并在同一个精确 feature switch 后挂载 Device client、身份适配器、远程文件系统与远程 Shell。关闭开关会同时禁用四条远程配置行，不恢复任何本地能力，因此不可用的灰度会以关闭能力的方式失败。

Slark Edge 通过每个 Cell 各自独立且仅监听 loopback 的 Writer 身份，发布私有 assignment 状态以及每个 DSH Session 一份的短期 authority 文件。`dsh-slark-identity` 在每次 Provider 操作时打开并校验 session 专属文件，通过受请求正文约束的 HMAC 请求刷新缺失或即将过期的 authority，检查 DSH 子进程中固定的 workspace handle，并通过 `AsyncLocalStorage` 绑定所得 authority。同一 session 的并发刷新共享一个请求；刷新响应与模型可见状态都不包含 subject token。

assignment 状态携带 generation 与 publication-version 围栏及所选 Workspace Grant。身份适配器以 Slark 别名注册该 workspace 的只读投影。已发布 assignment revision 变化时，supervisor 会替换 DSH 子进程；Edge 会等待替换完成再结束 bootstrap。每个 Writer 使用不同的 OS 身份与每 Cell 控制密钥，而 DSH 进程只能读取自身 authority 与投影目录。

默认 served Web HTTP 载体执行 Edge 的双重提交 CSRF 检查。每次 POST 前，载体读取 `__Host-dsh_csrf` cookie，并用其值覆盖 `x-slark-dsh-csrf`。cookie 缺失时不会生成该 header，Edge 会以关闭方式拒绝请求；自定义 transport 自行负责认证，WebSocket 下行不携带 CSRF token。

云端 Agent preset 只包含与 Provider 无关的 agent 能力，以及由远程文件系统或 Shell seam 支撑的工具。依赖 subprocess 的搜索、持久 terminal、LSP、hook、目录选择以及 Cordis／插件创作均不在其中。profile 同时禁用用户 preset 发现与 preset 切换。

CLI 把云端 preset 放在独立的随附根目录。只有组合后的 profile 含 Slark Device Provider 配置行时才选择该根目录，即使共享开关正禁用该配置行也是如此。独立版 profile 继续只发现普通随附根目录，因此既保留本地 Provider，也不会暴露含义错误的云端 preset。

Slark 云端客户端构建设置 `DSH_CLIENT_SLARK_WORKBENCH=1`。部署品牌浏览器插件据此占用 `sidebar.footer.action`，显示一个“企业工作台”链接。其精确的 `slark-workbench://switch/slark` 顶层导航由 Slark Desktop 的隔离 DSH view 接收，并在该白名单之外被拒绝；独立浏览器构建不会渲染该操作。

一个 DSH 子进程固定一个 workspace handle。选择其他 Workspace Grant 时会原子推进 assignment 状态并替换该子进程，不在活跃 Provider 边界内直接修改。

## 考虑过的替代方案

**让浏览器调用 Desktop 的 localhost 服务。** 不采用，因为浏览器安全策略、origin 信任、端口发现与企业代理会使 localhost 可达性不稳定；由 Desktop 认证的出站通道则让 Slark 在 macOS 和 Windows 上共用同一条受控路径。

**设备离线时保留本地 Provider 作为回退。** 不采用，因为在错误执行环境中成功执行比明确不可用更危险。本地 Provider 在独立版 DSH 中仍然正确，只在 Slark 云部署中刻意缺席。

**通过环境变量传入一个 subject token，或在进程范围缓存。** 不采用，因为轮换、并发 session 与重新 assignment 会使缓存 authority 过期或跨越租户边界。每 session 文件既支持并发身份，也不会把 token 放进命令参数；逐操作校验让撤销与 generation 围栏保持最新。

**让 Edge 以 Cell 用户身份写入 Cell 目录。** 不采用，因为被攻破的 Cell 随后可以冒充发布方，或修改其他 session 的 authority。独立 Writer 用户拥有发布权限，Cell 组只获得读取权限。

**只在 Web UI 隐藏本地工具与 preset 控件。** 不采用，因为模型工具、API 调用、已保存设置及非浏览器入口仍可访问宿主组合。边界由 Provider 配置行和发现根目录执行，而不是由展示层执行。

**只依赖 Desktop 键盘快捷键返回。** 不采用，因为隐藏的逃生路径无法让两个可见工作台形成统一产品体验。快捷键保留为恢复路径，侧边栏操作承担可发现的返回入口。

**让 Edge 只信任 session cookie，或由 Edge 把 cookie 复制成 header。** 不采用，因为两种做法都会把双重提交 CSRF 退化为普通 cookie 认证，使跨站 POST 也能通过同一检查。浏览器必须通过独立请求 header 证明脚本可读取 host-only CSRF cookie。

## 后果

Slark 云端 session 要么在当前 Workspace Grant 下访问选定 Device，要么明确失败；绝不会针对 Runtime Cell 的文件系统或 Shell 执行。关闭灰度开关是安全的，但会有意移除新 agent 组合的文件与 Shell 能力。

authority 发布、Writer 健康、Device 连通性、Grant 生命周期、supervisor 重载与 Edge CSRF cookie 签发成为部署健康信号。切换 workspace 会重启 DSH 子进程，并在其就绪前短暂阻塞 bootstrap。远程搜索暂时没有专用 Provider，因此需要搜索时由 agent 使用有界远程 Shell 命令。

撤销会冻结 Runtime Cell 并推进 generation；分配器只选择 `ready` Cell。被冻结的 Cell 绝不会带着现有 home 被重新分配。未来任何 Cell 回收机制都必须先清除租户状态，才能恢复 `ready` 状态。

独立版 DSH 行为不变：现有 preset 与本地 Provider 继续可用，其中无法发现 Slark 云端 preset，侧边栏也没有 Slark 返回操作。
