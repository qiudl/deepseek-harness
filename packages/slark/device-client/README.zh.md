# @deepseek-ai/dsh-slark-device-client

[English](README.md) | 中文

DeepSeek Harness 运行单元使用的 Slark Device Gateway 内部客户端。该插件注册 `ctx.slarkDevice`；能力提供方通过它创建一项持久化 Device Task，持续查询同一逻辑任务，并取得经过摘要校验的输出。

```ts ignore-check
import SlarkDeviceClient from '@deepseek-ai/dsh-slark-device-client'

await ctx.plugin(SlarkDeviceClient, {
  gatewayUrl: 'https://slark.example.com',
  serviceToken: process.env.SLARK_DSH_SERVICE_TOKEN,
})

ctx.slarkDevice.bindAuthority(async () => currentSlarkAuthority())
```

## 行为

- 身份适配器为每次操作提供新的短期 subject token，以及会话、计算机、工作区、Grant 和 epoch 围栏。token 只进入 header 或请求体，不会进入 URL 或错误信息。
- 创建任务时发生含糊的超时或传输失败，会复用相同请求体和幂等键重试。Gateway 一旦返回 task ID，后续传输重试只查询该任务；客户端不会创建替代逻辑任务。
- 状态分页必须由连续的 stdout 分块组成。客户端在返回字节前会校验序号、字节偏移、每块 SHA-256、完整结果 SHA-256、输出缺口标志、任务寿命和已配置的保留上限。
- 调用方取消后，客户端会尽力取消已知任务。如果取消请求未能完成，服务端任务过期时间和 Device 执行 lease 仍是有界停止保证。
- 不存在本地执行回退。身份缺失、工作区权限变化、Gateway 数据畸形、输出缺口和摘要错误都会通过 `SlarkDeviceClientError` 关闭失败。

## 模型体验

通过能力提供方间接影响模型；这些提供方把稳定的传输失败转换为模型可见的权限、取消或 I/O 结果。

#### KV Cache 影响

不会直接影响提示词。提供方结果沿用现有 schema。

## 已知限制与延后工作

- 该包需要部署注入内部 Gateway origin 和 service bearer，不是浏览器客户端。
- 后续身份插件负责获取和刷新 subject token。只加载该客户端时，所有操作都不可用。
- Device 输出受 `maxResultBytes` 限制；更大的产物必须走 task-scoped artifact 路径，不能使用 stdout。
