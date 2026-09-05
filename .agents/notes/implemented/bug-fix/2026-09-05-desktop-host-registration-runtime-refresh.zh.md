# Agent Note: Desktop Host registration follows runtime upgrades

Status: implemented

[English](2026-09-05-desktop-host-registration-runtime-refresh.md) | 中文

## Problem

owner-only DSH Host discovery 记录会固定 packaged Node executable digest。Desktop 升级会改变该 digest，同时保留 Host installation identity、endpoint registration、public key 与 socket path。如果把所有 digest 差异都视为外部所有者冲突，那么即使升级后的 Host 已取得独占 Host lock，也无法启动。

## Decision

Host 启动只接受字段集合完全有效，且 installation id、installation public key、endpoint registration id 与 socket path 均和当前 Host 一致的已有 discovery 记录。取得 Host 独占所有权后，启动流程会用可信 embedding application 提供的 digest 原子替换有效的旧 executable digest。

格式错误的记录、变化的身份字段、变化的 endpoint 或 socket 所有权、符号链接、意外字段，以及非 owner-writable 文件仍然 fail closed。Runtime 轮换不会削弱单 Host 所有权或原生 peer attestation：discovery client 会根据实际拥有 socket 的进程校验新发布的 digest。

## Testing

macOS 启动组合测试会关闭一个 Host，只改变其 executable digest，再次启动，并要求 discovery 记录包含替换后的 digest。同一测试仍会拒绝第二个正在运行的 Host、不同的 installation id 和由符号链接替换的记录。

## Alternatives considered

**每次启动前由 Desktop 删除 discovery 记录。** 不采用，因为 Desktop 会绕过 Host 包拥有的 owner、格式、身份与原子写入校验，并且可能删除真实所有权冲突的证据。

**继续把所有 digest 差异视为冲突。** 不采用，因为 executable 轮换属于签名 Desktop 的正常升级，而独占 Host lock 与保持不变的 installation identity 已经可以区分第二个所有者。

**取得 lock 后接受所有 discovery 字段变化。** 不采用，因为该 lock 保护一个 Host root，并不保护共享 discovery 位置中的无关 installation、endpoint、key 或 socket identity。

## Consequences

签名 Desktop 升级可以启动已有 Host installation，不需要手工清理 discovery 文件。身份、endpoint、key、socket path 变化，digest 格式错误或文件不安全时，启动仍会被阻止；client 只能通过原子文件更新看到替换后的 digest。
