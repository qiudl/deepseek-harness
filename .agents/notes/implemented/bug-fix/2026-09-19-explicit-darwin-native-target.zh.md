# Agent Note: 显式指定 Darwin 原生目标架构

Status: implemented

[English](2026-09-19-explicit-darwin-native-target.md) | 中文

## Problem

通过 Rosetta 运行的 x64 Node 进程不会强制 Apple 的通用 `cc` 驱动选择 x86_64 输出。因此，在 Apple Silicon 构建机上编译声明为 `darwin-x64` 的 addon 时，如果没有显式指定目标架构，就可能生成 arm64 Mach-O bundle（捆绑包）。平台包的 prepack 检查会正确拒绝这种标签错误的二进制文件，所以消费方无法在该构建机上组装真正的 Intel 运行时。

## Decision

native-system 构建器向 clang 传入根据 Node 进程架构确定的 Darwin `-arch` 参数：`arm64` 映射到 `arm64`，Node `x64` 映射到 clang `x86_64`。任何其他 macOS 架构都会在编译前失败。Linux 编译器参数保持不变。

该映射由独立函数实现并接受测试。既有平台包验证仍作为独立的产物检查，验证最终 Mach-O 的 CPU 类型和 bundle 文件类型。

## Alternatives considered

**根据物理机器推断目标架构。** 不采用，因为发布流程可能有意在 Apple Silicon 上通过 Rosetta 运行 x64 Node 进程。Node 进程架构决定正在构建的平台包。

**依靠 Rosetta 影响 `cc` 的默认行为。** 不采用，因为在发生问题的发布环境中，Apple 通用编译器仍然选择了 arm64。

**禁用平台包架构检查。** 不采用，因为这会以 Intel 包名发布 arm64 二进制文件，并把失败推迟到消费方。

## Consequences

当构建在匹配的 Node 架构下运行时，同一台 Apple Silicon 构建机可以生成任一声明的 macOS addon。编译器目标选择是确定性的，并对不支持的 Node 架构保持失败关闭。macOS 构建依赖 clang 接受标准的 `arm64` 和 `x86_64` 目标名称。

## Verification

compiler-target 单元测试固定两个受支持的映射以及不支持架构的失败行为。原生包测试继续拒绝与包元数据不一致的 Mach-O CPU 类型。正式 Intel Desktop 组装会执行 x64 编译路径及其 prepack 验证。
