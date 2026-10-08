# REQ-20260930-0004 B220 — 协同历史的 Remote 依赖

[English](REQ-20260930-0004-b220-remote-injection.md) | 中文

ai-proj 项目 212 / Requirement 5845 / Task 23070；产品修改前已记录需求审批和自评审。工作笔记记录了确切的 Native 基线。

Boston 的真实历史视图在执行 `resultsCtx.remote.session.collaborationSources` 时反复抛出 `cannot get property "remote" without inject`。通过浏览器正常 RPC 读取相同的两个自有 Session 均返回 HTTP 200 和空 Source 列表。这些证据表明 Client 缺少依赖声明，而非存储损坏。

结果区域现在在已有 `remote.session` 依赖之外显式注入 `remote`。结果归属、Session 清理和只读传输保持原有行为。

回归验证：Loader 测试夹具现在可以通过真实插件所有者提供 Remote，不再仅由根 Context 提供。在严格 Cordis 运行时中，新增的历史读取测试在修复前失败，Source 读取没有到达服务提供者。修复后测试通过，并验证销毁会停止后续读取。这解释了之前由根 Context 提供的测试替身为何掩盖了生产依赖错误。

验证：ui-slark-agent 的 11 个文件共 357 项测试通过；composer Loader 的 164 项测试通过；Client 汇总类型检查和变更文件的类型感知 lint 通过。RED/GREEN 日志分别为 /private/tmp/req20260930-b220-red.log 和 /private/tmp/req20260930-b220-green.log。磁盘格式、Account 数据和凭据均未改变。第二轮限定范围的缺陷检查未发现依赖修复中的新问题；实际签名包的历史读取以及独立的聊天受理故障仍未验收。
