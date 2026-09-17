import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  cancelDesktopAttachmentSave, IconCloseOutline16, IconDownloadOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ImageLightbox.module.css'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
  /** Accessible label of the zoom-out control. */
  zoomOut: string
  /** Accessible label of the zoom-in control. */
  zoomIn: string
  /** Accessible label of the fit/reset control. */
  resetZoom: string
  /** Accessible label of the native Save As control. */
  save: string
  /** Visible status while the native host is saving. */
  saving: string
  /** Visible confirmation after a successful save. */
  saved: string
  /** Visible failure when the native host rejects the save. */
  saveFailed: string
  /** Accessible label used while the save control cancels an in-flight transfer. */
  cancelSave: string
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and close-control strings.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, onClose, onSave }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  onClose: () => void
  onSave?: (onProgress: (progress: { receivedBytes: number; totalBytes: number }) => void) =>
  Promise<'saved' | 'cancelled' | 'unsupported' | 'failed'>
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchDistance = useRef<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(zoom)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [savePercent, setSavePercent] = useState<number | null>(null)

  const changeZoom = useCallback((next: number): void => {
    const bounded = Math.min(4, Math.max(0.25, next))
    zoomRef.current = bounded
    setZoom(bounded)
    if (bounded <= 1) setPan({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key === 'Tab') {
        const controls = [...(
          dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []
        )]
        if (controls.length === 0) return
        const current = controls.indexOf(document.activeElement as HTMLElement)
        const next = event.shiftKey
          ? (current <= 0 ? controls.length - 1 : current - 1)
          : (current === controls.length - 1 ? 0 : current + 1)
        event.preventDefault()
        controls[next]?.focus()
        return
      }
      if (event.key === '+' || event.key === '=') changeZoom(zoomRef.current + 0.25)
      else if (event.key === '-') changeZoom(zoomRef.current - 0.25)
      else if (event.key === '0') {
        zoomRef.current = 1
        setZoom(1)
        setPan({ x: 0, y: 0 })
      } else if (event.key.startsWith('Arrow') && zoomRef.current > 1) {
        const delta = 40
        setPan(current => ({
          x: current.x + (event.key === 'ArrowLeft' ? delta : event.key === 'ArrowRight' ? -delta : 0),
          y: current.y + (event.key === 'ArrowUp' ? delta : event.key === 'ArrowDown' ? -delta : 0),
        }))
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [changeZoom, onClose])

  return createPortal(
    <div
      ref={dialogRef}
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <div
        className={css.viewport}
        onWheel={(event) => {
          event.preventDefault()
          changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25))
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          if (pointers.current.size === 2) pinchDistance.current = pointerDistance(pointers.current)
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId)
          if (previous === undefined) return
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          if (pointers.current.size === 2) {
            const distance = pointerDistance(pointers.current)
            if (pinchDistance.current !== null && distance > 0) {
              changeZoom(zoom * distance / pinchDistance.current)
            }
            pinchDistance.current = distance
          } else if (zoom > 1) {
            setPan(current => ({
              x: current.x + event.clientX - previous.x,
              y: current.y + event.clientY - previous.y,
            }))
          }
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId)
          pinchDistance.current = null
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId)
          pinchDistance.current = null
        }}
      >
        <img
          className={css.image}
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        />
      </div>
      <div className={css.toolbar}>
        {onSave !== undefined && (
          <button
            type="button"
            data-testid="attachment-btn-save"
            aria-label={saveState === 'saving' ? labels.cancelSave : labels.save}
            onClick={() => {
              if (saveState === 'saving') {
                void cancelDesktopAttachmentSave()
                return
              }
              setSaveState('saving')
              setSavePercent(null)
              void onSave(({ receivedBytes, totalBytes }) => {
                setSavePercent(totalBytes === 0 ? 100 : Math.min(100, Math.floor(receivedBytes * 100 / totalBytes)))
              }).then((outcome) => {
                setSavePercent(null)
                setSaveState(outcome === 'saved' ? 'saved' : outcome === 'cancelled' ? 'idle' : 'failed')
              }, () => { setSavePercent(null); setSaveState('failed') })
            }}
          >
            <IconDownloadOutline16 size={16} />
          </button>
        )}
        <button type="button" data-testid="attachment-btn-zoom-out" aria-label={labels.zoomOut} disabled={zoom <= 0.25} onClick={() => { changeZoom(zoom - 0.25) }}>−</button>
        <button type="button" data-testid="attachment-btn-zoom-reset" aria-label={labels.resetZoom} onClick={() => { changeZoom(1) }}>{Math.round(zoom * 100)}%</button>
        <button type="button" data-testid="attachment-btn-zoom-in" aria-label={labels.zoomIn} disabled={zoom >= 4} onClick={() => { changeZoom(zoom + 0.25) }}>+</button>
      </div>
      {saveState !== 'idle' && (
        <span className={css.saveStatus} role="status" aria-live="polite">
          {saveState === 'saving'
            ? `${labels.saving}${savePercent === null ? '' : ` ${savePercent}%`}`
            : saveState === 'saved' ? labels.saved : labels.saveFailed}
        </span>
      )}
      <span className={css.zoomStatus} role="status" aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button ref={closeRef} type="button" data-testid="attachment-btn-close" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>,
    document.body,
  )
}

function pointerDistance(pointers: ReadonlyMap<number, { x: number; y: number }>): number {
  const [first, second] = [...pointers.values()]
  return first === undefined || second === undefined
    ? 0
    : Math.hypot(second.x - first.x, second.y - first.y)
}
