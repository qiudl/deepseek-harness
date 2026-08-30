export const zh = {
  tab: '插件市场', title: '发现 DSH 插件', subtitle: '浏览经过目录校验的社区插件。目录收录不代表安全审核。',
  search: '搜索名称、作者或描述', category: '分类', source: '来源', all: '全部', github: 'GitHub', npm: 'npm', tarball: 'Release 包',
  installed: '仅已安装', prebuilt: '预构建分发', prebuiltHint: 'npm 或声明的 Release 包；不代表没有生命周期脚本。', relevance: '相关度', name: '名称', loading: '正在查询插件目录…', error: '插件目录暂时不可用。',
  retry: '重试', empty: '没有符合条件的插件', emptyHint: '减少筛选条件，或换一个更宽泛的关键词。', reset: '清空筛选',
  results: '个匹配插件', candidate: '目录候选', stale: '目录数据可能已过期', current: '目录已验证', sourceLabel: '精确来源',
  revision: '目录 revision', close: '关闭详情', unavailable: 'M1 仅支持发现；安装将在可信确认流程上线后开放。', next: '下一页', previous: '上一页',
} satisfies Record<string, string>
export type PluginMarketLocaleKey = keyof typeof zh
export const en = {
  tab: 'Plugin market', title: 'Discover DSH plugins', subtitle: 'Browse catalog-validated community plugins. Listing is not a security review.',
  search: 'Search name, owner, or description', category: 'Category', source: 'Source', all: 'All', github: 'GitHub', npm: 'npm', tarball: 'Release archive',
  installed: 'Installed only', prebuilt: 'Prebuilt distribution', prebuiltHint: 'npm or a declared release archive; this does not assert that lifecycle scripts are absent.', relevance: 'Relevance', name: 'Name', loading: 'Searching the plugin catalog…', error: 'The plugin catalog is temporarily unavailable.',
  retry: 'Retry', empty: 'No plugins match', emptyHint: 'Remove a filter or try a broader query.', reset: 'Clear filters',
  results: 'matching plugins', candidate: 'Catalog candidate', stale: 'Catalog data may be stale', current: 'Catalog validated', sourceLabel: 'Exact source',
  revision: 'Catalog revision', close: 'Close details', unavailable: 'M1 supports discovery only. Installation will open with the trusted confirmation flow.', next: 'Next page', previous: 'Previous page',
} satisfies Record<PluginMarketLocaleKey, string>
