# Agent 说明：从已封装的 Windows 启动产物导出存储适配器

状态：已实现

[English](2026-09-15-windows-sealed-startup-storage-exports.md) | 中文

## 问题

Windows 桌面嵌入端在准备本机 Profile 凭据库和旧数据源探针前，会校验并导入发布封装的 `windows-startup.js` 产物。这两个适配器虽已实现并从通用 `startup.js` 产物导出，却未从封装的 Windows 产物导出。因此，安装包启动在完成 Host 身份创建后，会因缺少预期的存储导出而安全失败。

## 决策

从 Windows 启动入口重新导出 `loadWindowsLocalProfileStorage` 和 `loadWindowsLegacySourceProbe`。嵌入端继续只使用同一个按发布版本锁定并校验哈希的产物，不引入第二个受信任脚本。扩展构建产物测试，在从内存导入独立 Windows bundle 后断言两个导出均存在。

## 考虑过的替代方案

**让嵌入端改用通用启动产物。** 拒绝，因为这会扩大 Windows 封装启动面的范围，并改变 Host 组合所使用的产物契约。

**通过未经校验的包路径加载存储实现。** 拒绝，因为本机 Profile 密文访问必须继续绑定到发布锁定代码和持有中的原生模块租约。

## 后果

Windows 嵌入端和旧数据源探针可以从其已经校验字节的产物加载适配器。适配器实现及其安全失败的原生权限检查保持不变。
