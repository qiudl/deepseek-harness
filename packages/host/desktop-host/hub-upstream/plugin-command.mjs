// Generated pure command builder from pinned Hub plugins.ts; see UPSTREAM.json and LICENSE.
/** 构造 dsh plugin 子命令 argv（纯函数，便于单测） */
export function buildPluginCommand(profile, action, args = []) {
    return ['plugin', '--profile', profile, action, ...args];
}
