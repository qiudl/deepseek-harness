# Agent Note: 原生操作的实际结束

Status: implemented

[English](2026-11-07-native-operation-settlement.md) | 中文

## 问题

取消 socket 或 HTTP 请求会使父 Promise 结束，但 Profile service 可能仍在执行。此时释放并发名额会放入超过 8 个真实操作。子进程的错误事件也不证明进程已经退出。

## 决策

默认 Host 的唯一 Web worker factory 跨 Profile 和连接拥有 8 个原生操作名额。调用截止时间和取消分别结束等待。经过鉴权的接收器只在 service 实际结束后，返回对应操作的收据。没有收据时，名额保留到原子进程实际退出。worker 关闭流程仍可终止出错但存活的子进程，完成状态等待实际退出。

## 已考虑的替代方案

计数 broker Promise 或在 fetch 拒绝时释放，只约束等待，不约束 service 执行。每个 worker 各自计数，会在多个 Profile 和 worker 替换时放入过量操作。持久操作台账增加存储和恢复职责，却不能改善进程退出证据。仅为回收未知名额而杀死用户 worker，会干扰其他 Session。

## 验证

8 个调用取消后可仍有 8 个 service 执行，第 9 个必须 busy，直到其中一个实际结束。混合原生路由共享上限。收据缺失和 HTTP 断链仍占槽，只有原进程退出才回收。进程发生错误但尚未退出时，worker 关闭不能结束。成功证明仍须检查当前 Account、worker 和取消状态。

## 结果与代价

收据不可用可能使容量保留到 worker 重启。旧接收器可能先执行却不返回收据，不能证明实际结束。取消不撤销已接收的原子操作。恢复保留原群、Source 和成员身份。
