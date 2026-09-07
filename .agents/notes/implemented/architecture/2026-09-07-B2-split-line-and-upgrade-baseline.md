# REQ-20260907-0016: B2 拆线原则与升级基线（协同 qiu-slark REQ-20260907-0014）

状态：approved/dev（REQ-20260907-0016）；fork master @ d85ecaff（0.1.2-alpha.1）；上游固定基线 = 0.1.3-alpha.1 head（d347e703 时代；CI 使用输入 SHA，禁止移动 ref）。

## 拆线两栏表（B2 实施纪律）
| 能力 | 去向 |
|---|---|
| events 游标/截断、session rename/delete/leave、approval v2 settle 幂等、supportedProtocolVersions 协商、conformance 夹具 | 上游 PR（合入后才算完成） |
| mobile caller profile、engine/environment claims、capability 广告、slark identity/fs/shell adapter、cloud preset 开关 | fork overlay（packages/slark*、bundle/slark-cloud、host/slark-identity） |
| host core（host/core/session/interaction src）出现 slark 专属值域 | host-core-slark-sniff（required，任一命中即红） |

## 门禁与探针（本分支）
- scripts/host-core-slark-sniff.mjs + .github/workflows/host-core-gate.yml（required check：host-core-slark-sniff）
- .dsh-slark-value-domain.json：受控值域清单（默认空 → 基线绿）
- .github/workflows/drift-probe.yml：上游漂移探针（周度 + dispatch，total≥50 可选 fail）
- .github/workflows/rebase-smoke-report.yml：overlay 12 内容提交 → 指定上游 SHA 的逐条试合报告（report-only，上传 artifact）

## 预研数据（2026-09-07，本地）
固定上游 d347e703 上逐条隔离试合：OK 1/12，CONFLICT 11/12；冲突集中于 host/desktop-host、control-protocol、session-persistence-jsonl、core/session、core/agent-loop、apps/cli、docs i18n。主形态为语义适配（类 2）；全量 D1 报告按 REQ-20260907-0016 §4 执行。
