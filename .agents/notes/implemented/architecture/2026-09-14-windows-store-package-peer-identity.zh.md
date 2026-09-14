# Agent Note: Windows Store 包身份对端认证

Status: implemented

[English](2026-09-14-windows-store-package-peer-identity.md) | 中文

## 问题

Microsoft Store 在认证后签署外层 MSIX 包，但不会为其中的 Desktop 与 Host 可执行文件添加 Authenticode 签名。因此，强制要求内层可执行文件的发布者证书会拒绝有效的 Store 安装；如果只接受 package family name 而不证明可执行文件位置，具有关联包身份的进程又可能认证受保护安装根目录之外的字节。

## 决策

Windows 管道对端认证使用两种发布固定身份模式组成的封闭联合。Authenticode 模式要求一个或多个允许的发布者指纹。Store 模式要求一个或多个允许的 package family name，通过稳定进程句柄取得对端 package full name，经 Win32 包 API 派生 family name 与受保护安装路径，并要求稳定可执行文件路径是该根目录的后代。两种模式都要求相同用户 SID 与允许的 SHA-256 可执行文件摘要。

Worker 启动数据同时携带两类身份列表，但只接受其中一个非空。就绪证据只携带所选模式的身份事实，父线程在接受 Worker 前再次用自己的信任快照校验该事实。

## 考虑的替代方案

**要求 MSIX 内层 Authenticode**——未采用，因为 Microsoft Store 不会提供该签名，而且 Store 渠道仍会依赖付费证书。

**只信任 package family name**——未采用，因为包关联本身不能证明已认证可执行文件字节来自受保护的包安装目录。

**把 Host 可执行文件复制到可写用户存储**——未采用，因为副本会失去 Store 身份模式所依赖的包路径完整性证据。

## 后果

NSIS 渠道保留发布者与摘要策略。Store 渠道可以使用 Microsoft 管理的包签名，而不把对端身份弱化为路径字符串或单独摘要。Store 打包的嵌入方必须从受保护包文件运行两个对端，固定 Partner Center package family name，并随每次发布更新可执行文件摘要。原生 Windows 执行仍负责验证包 API ABI 与安装路径行为。
