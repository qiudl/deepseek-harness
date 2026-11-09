# Agent Note: 绑定限定的原生群准备

Status: implemented

[English](2026-11-07-bound-native-room-preparation.md) | 中文

## Problem

房间 ID 和 Account Profile 不能证明选定 Bot 仍在群中。先读参与再调用无参与限制的准备方法，存在创建竞态。原 native-room assertion 也缺少 Cloud 协调器所需的绑定、nonce 和准确 Profile。异步授权 helper 最后检查通过后，到父进程签名之前，仍可能发生撤权或 worker 替换。

## Decision

独立准备能力每次请求只执行一个阶段。target 和 proof 绑定原参与者、完整 Source、Profile、绑定选择值、audience 和短期 nonce。worker 创建前要求插件提供限定参与的准备入口；已知 Source 和两个证明阶段只读原严格 journal。worker 仅返回未签名观察，父进程分别签署原凭据和独立准备域。

父进程一直保留原 worker receiver 及其同步当前性检查，直到最终发布。每次签名及发送响应前，均同步检查它以及 Account、Profile、nonce 和取消状态。同 Profile 的替代 worker 不能证明旧观察。唯一默认 factory 与其他原生操作共享既有的实际结束预算。

## Alternatives considered

调用旧准备方法后再比较，仍允许创建不应产生的 Source。只复用旧 assertion 会缺少选定参与者和一次性上下文。把安装签名权交给 child 会扩大其权限。仅在异步 helper 内复核，无法保护它返回后的继续执行。按 Profile 重新选择 worker，会接受没有产生原观察的替代者。

## Consequences

旧插件或 worker 缺少支持时明确要求升级，不回落。未知写入保留原 Source 意图；取消不撤销已接收执行的原子操作。完整转义响应在签名前检查上限，不截断。这些观察不授予 Cloud 群、模型或设备权限；当前业务授权和事务提交仍由 Cloud 协调器负责。
