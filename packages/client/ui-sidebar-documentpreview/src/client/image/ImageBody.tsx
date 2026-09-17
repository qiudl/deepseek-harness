/** Complete image bytes rendered at their intrinsic CSS-pixel dimensions. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf } from '../rpc.ts'
import type {} from './locales.ts'
import css from './ImageBody.module.css'

const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
} as const

type ImageMediaType = typeof IMAGE_MEDIA_TYPES[keyof typeof IMAGE_MEDIA_TYPES]

/** Standard document props plus the image renderer's dictionary. */
export type ImageBodyProps = DocumentPreviewProps & PropsLocale<'sidebarImage'>

type ImageSource =
  | {
    readonly kind: 'ready'
    readonly data: Uint8Array<ArrayBuffer>
    readonly mediaType: ImageMediaType
    readonly url: string
  }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer>; readonly mediaType: ImageMediaType }

/**
 * Resolve a supported filename to the media type assigned to its Blob.
 * @param path - decoded workspace file path.
 * @returns the image media type, or undefined for an unregistered suffix.
 */
export function imageMediaType(path: string): ImageMediaType | undefined {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const extension = name.slice(name.lastIndexOf('.') + 1) as keyof typeof IMAGE_MEDIA_TYPES
  return IMAGE_MEDIA_TYPES[extension]
}

/**
 * Present complete image bytes without fitting or scaling them to the pane.
 * @param props - document bytes, resource identity, and locale.
 * @returns an intrinsic-size image whose containing document body provides scrolling.
 */
export function ImageBody({ content, resourceAddress, t }: ImageBodyProps): ReactNode {
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  const mediaType = imageMediaType(path)
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<ImageSource>()

  useEffect(() => {
    if (data === undefined || mediaType === undefined) return
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
      setSource({ kind: 'ready', data, mediaType, url })
    } catch {
      setSource({ kind: 'failed', data, mediaType })
    }
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, mediaType])

  if (data === undefined || mediaType === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source?.data !== data || source.mediaType !== mediaType) {
    return <LoadingIndicator className={css.status} label={t('loading')} />
  }
  if (source.kind === 'failed') return <p className={css.status} role="alert">{t('failed')}</p>
  const { name } = pathPartsOf(path)
  return <LoadedImage key={source.url} url={source.url} name={name} t={t} />
}

/** SVG stays in the browser's static image mode because its bytes only reach an img Blob URL. */
function LoadedImage({ url, name, t }: {
  readonly url: string
  readonly name: string
  readonly t: ImageBodyProps['t']
}): ReactNode {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [zoom, setZoom] = useState(1)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>()
  const changeZoom = useCallback((next: number): void => {
    setZoom(Math.min(4, Math.max(0.25, next)))
  }, [])
  return <div
    className={css.frame}
    data-image-preview
    tabIndex={0}
    aria-label={t('preview', { name })}
    onKeyDown={(event) => {
      if (event.key === '+' || event.key === '=') changeZoom(zoom + 0.25)
      else if (event.key === '-') changeZoom(zoom - 0.25)
      else if (event.key === '0') changeZoom(1)
      else return
      event.preventDefault()
    }}
    onWheel={(event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25))
    }}
  >
    {state === 'loading' && <LoadingIndicator className={css.status} label={t('loading')} />}
    {state === 'failed' && <p className={css.status} role="alert">{t('failed')}</p>}
    {state === 'ready' && <div className={css.toolbar}>
      <button type="button" aria-label={t('zoomOut')} disabled={zoom <= 0.25} onClick={() => { changeZoom(zoom - 0.25) }}>−</button>
      <button type="button" aria-label={t('resetZoom')} onClick={() => { changeZoom(1) }}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label={t('zoomIn')} disabled={zoom >= 4} onClick={() => { changeZoom(zoom + 0.25) }}>+</button>
    </div>}
    <img
      className={css.image}
      src={url}
      alt={t('preview', { name })}
      decoding="async"
      draggable={false}
      referrerPolicy="no-referrer"
      hidden={state !== 'ready'}
      style={dimensions === undefined ? undefined : {
        width: dimensions.width * zoom,
        height: dimensions.height * zoom,
      }}
      onLoad={(event) => {
        setDimensions({
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight,
        })
        setState('ready')
      }}
      onError={() => { setState('failed') }}
    />
  </div>
}
