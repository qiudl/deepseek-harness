# Agent Note: Skill Hub 时钟锚 epoch

Status: proposed

[English](2026-10-22-skillhub-clock-anchor-epochs.md) | 中文

## Problem

Host 最多保留 4,096 个离线时钟锚的精确 revision。原协议允许调用方提交任意 UUID；旧记录被删除后，Host 无法区分该 UUID 与从未见过的新 UUID，可能再次接受 revision-zero compare-and-set。若永久保留所有记录，长期运行的 Host 又会拒绝新的在线登记。

## Proposal

Host 在当前 Profile 授权下签发新锚 UUID 和一次性票据。首次 compare-and-set 携带该票据与当前随机 epoch。Host 清空有界记录前先轮换 epoch，使旧见证和待用票据失效。满额时若本次签发 Work，Host 只在新代次保留当前选中的资产见证；Daemon 在线刷新该资产权限后才登记 Work。Server 通过认证的在线时间确认 Host 签发的 UUID；Daemon 把 epoch 纳入离线权限，并在每次动作前核对。V1 见证保留独立的容量限制兼容路径。

## Alternatives considered

**驱逐 V1 记录。** 没有可验证的签发证明时，旧 UUID 在驱逐后仍可重新初始化。LRU 和按时间驱逐都有同样缺口。

**满额重启 Host。** 新进程的启动 nonce 会使现有离线权限失效，但清空记录后的 V1 仍接受任意 UUID；重启也会中断其他 Host 工作。

**持久精确记录。** 持久墓碑可拒绝旧 UUID，但需要跨 Host 升级保证存储完整性、备份和增长策略。若所有调用方一起迁移，有界 epoch 协议可避免持久状态。

## Acceptance criteria

轮换后，第 4,097 个 Host 签发锚可以初始化。旧锚即使配上新票据，也不能在新 epoch 初始化；旧票据在任何 epoch 都不能初始化。Work 触发轮换时，只有选中的资产见证能在新代次读取，其他旧见证全部消失。轮换后，进行中的资产与 Work 在后续不可逆动作前拒绝。在线刷新能在轮换后成功，V1 路径仍在自身容量满时拒绝新锚。

## Risks

epoch 轮换会撤销现有离线权限。Work 触发轮换时会保留一个资产见证，但原始 Work 必须在资产权限重新在线刷新后才能登记；刷新失败则拒绝登记。若调用方未能在票据过期前完成 Server 确认，必须重新取票据。部分部署期间必须关闭 V2 离线执行；仅声明 Host capability 不等于完成 Server 与 Daemon 的核对。
