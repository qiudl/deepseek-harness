/** Simplified Chinese dictionary and key source of truth. */
export const zh = { title: '扩展中心' } satisfies Record<string, string>

/** Typed key accepted by the Extension Center locale function. */
export type ExtensionCenterLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = { title: 'Extension Center' } satisfies Record<ExtensionCenterLocaleKey, string>
