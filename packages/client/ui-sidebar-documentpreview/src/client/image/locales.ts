/** Locale-owned image renderer labels and status text. */
export const zh = {
  title: '图片',
  preview: '图片预览：{name}',
  loading: '正在打开图片…',
  failed: '无法显示这张图片。',
  unsupported: '图片预览需要完整文件内容。',
  zoomOut: '缩小图片',
  zoomIn: '放大图片',
  resetZoom: '重置图片缩放',
} satisfies Record<string, string>

/** Image renderer dictionary keys. */
export type ImagePreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Image',
  preview: 'Image preview: {name}',
  loading: 'Opening image…',
  failed: 'This image could not be displayed.',
  unsupported: 'Image preview requires the complete file contents.',
  zoomOut: 'Zoom image out',
  zoomIn: 'Zoom image in',
  resetZoom: 'Reset image zoom',
} satisfies Record<ImagePreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image preview selection, accessible name, and status text. */
    sidebarImage: ImagePreviewKey
  }
}
