# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

仅当 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时，本包才填充 `sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark`。设置 `DSH_CLIENT_SLARK_WORKBENCH=1` 的构建还会在 `sidebar.footer.action` 填入“企业工作台”链接，其精确的 `slark-workbench://switch/slark` 导航信号由 Slark Desktop 接收。未设置对应选择器的构建会让相应 slot 保持为空。

三个 official occupant 通过嵌套的 `slots.inject()` 作为一组声明感知注册安装。Slark 返回操作独立安装，因此云端工作台不会继承 DeepSeek official 品牌。两项注册无论先于还是后于 slot 声明方激活都能工作，并在 HMR teardown 时撤回。本包不保留运行时状态。node 半边是空的 Loader seat；浏览器标题仍属于本包之外的构建环境事项。

## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **本包提供固定的部署 occupant** —— 其他呈现应由占用相同 slot 的另一个 Cordis 包提供。
- **Slark 链接依赖 Desktop 宿主** —— 普通浏览器构建不设置 `DSH_CLIENT_SLARK_WORKBENCH`，因此不会渲染自定义协议操作。
- **浏览器标题相互独立** —— `DSH_CLIENT_TITLE` 在构建期选择标题文字，而不经过 UI slot。
