// oxlint-disable jsx-a11y/prefer-tag-over-role -- ARIA window-splitter pattern: focusable separator divs carry drag/keyboard handlers, which hr rejects
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'

/**
 * Workspace layout primitives: localStorage-persisted pane sizes, the <=1000px stacking media
 * query, and the pointer-capture based splitters (drag, double-click reset, arrow-key resize).
 */

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const readNumber = (key: string, fallback: number): number => {
  if (typeof localStorage === 'undefined') {
    return fallback
  }

  const raw = localStorage.getItem(key)
  const value = raw === null ? Number.NaN : Number(raw)

  return Number.isFinite(value) ? value : fallback
}

const HANDLE =
  'shrink-0 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 active:bg-accent/60'

interface DragHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

/** Text in the panes must not get selected while dragging or double-clicking a splitter. */
const suppressSelection = (on: boolean): void => {
  document.body.style.userSelect = on ? 'none' : ''

  if (on) {
    getSelection()?.removeAllRanges()
  }
}

const useDrag = (onDrag: (event: ReactPointerEvent<HTMLElement>) => void): DragHandlers => {
  const dragging = useRef(false)

  return {
    onPointerDown: event => {
      dragging.current = true
      suppressSelection(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: event => {
      if (dragging.current) {
        onDrag(event)
      }
    },
    onPointerUp: event => {
      dragging.current = false
      suppressSelection(false)

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    onPointerCancel: () => {
      dragging.current = false
      suppressSelection(false)
    },
  }
}

export const SPLIT_KEY = 'ozaco-panel:split'
export const SIDEBAR_KEY = 'ozaco-panel:sidebar-w'

export interface PersistBounds {
  readonly fallback: number
  readonly min: number
  readonly max: number
}

/** Request pane width as % of the dual-pane container. */
export const SPLIT_BOUNDS: PersistBounds = { fallback: 50, min: 25, max: 75 }

/** Sidebar width in px. */
export const SIDEBAR_BOUNDS: PersistBounds = { fallback: 280, min: 200, max: 440 }

/** Clamped numeric state persisted under a localStorage key (quota errors are ignored). */
export const usePersistedNumber = (
  key: string,
  bounds: PersistBounds,
): readonly [number, (next: number) => void] => {
  const [value, setValue] = useState(() =>
    clamp(readNumber(key, bounds.fallback), bounds.min, bounds.max),
  )

  const update = useCallback(
    (next: number): void => {
      const clamped = clamp(next, bounds.min, bounds.max)

      setValue(clamped)

      try {
        localStorage.setItem(key, String(Math.round(clamped)))
      } catch {
        // storage unavailable — keep the in-memory value
      }
    },
    [key, bounds],
  )

  return [value, update]
}

/** True below the stacking breakpoint — request/response panes stack vertically. */
export const useStacked = (): boolean => {
  const [stacked, setStacked] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 1000px)').matches,
  )

  useEffect(() => {
    const media = matchMedia('(max-width: 1000px)')
    const onChange = (): void => {
      setStacked(media.matches)
    }

    media.addEventListener('change', onChange)

    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [])

  return stacked
}

/**
 * Request | response dual pane with a draggable vertical splitter. Below the stacking breakpoint
 * the two panes stack 50/50 and the splitter disappears. Children: [request, response].
 */
export const SplitLayout = ({
  split,
  onSplit,
  stacked,
  children,
}: {
  /** Request pane width as a percentage of the container. */
  readonly split: number
  readonly onSplit: (pct: number) => void
  readonly stacked: boolean
  readonly children: readonly ReactNode[]
}) => {
  const container = useRef<HTMLDivElement | null>(null)

  const drag = useDrag((event: ReactPointerEvent<HTMLElement>): void => {
    const rect = container.current?.getBoundingClientRect()

    if (rect !== undefined && rect.width > 0) {
      onSplit(((event.clientX - rect.left) / rect.width) * 100)
    }
  })

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowLeft') {
      onSplit(split - 2)
    } else if (event.key === 'ArrowRight') {
      onSplit(split + 2)
    } else if (event.key === 'Home') {
      onSplit(SPLIT_BOUNDS.min)
    } else if (event.key === 'End') {
      onSplit(SPLIT_BOUNDS.max)
    }
  }

  if (stacked) {
    return (
      <div className='flex min-h-0 flex-1 flex-col'>
        <div className='border-line min-h-0 flex-1 basis-1/2 overflow-hidden border-b'>
          {children[0]}
        </div>
        <div className='min-h-0 flex-1 basis-1/2 overflow-hidden'>{children[1]}</div>
      </div>
    )
  }

  return (
    <div ref={container} className='flex min-h-0 flex-1'>
      <div className='min-w-0 overflow-hidden' style={{ width: `${split}%` }}>
        {children[0]}
      </div>
      <div
        aria-label='Resize request and response panes'
        aria-orientation='vertical'
        aria-valuemax={SPLIT_BOUNDS.max}
        aria-valuemin={SPLIT_BOUNDS.min}
        aria-valuenow={Math.round(split)}
        className={`${HANDLE} border-line w-1 cursor-col-resize self-stretch border-l select-none`}
        onDoubleClick={() => {
          getSelection()?.removeAllRanges()
          onSplit(SPLIT_BOUNDS.fallback)
        }}
        onKeyDown={onKeyDown}
        role='separator'
        tabIndex={0}
        {...drag}
      />
      <div className='min-w-0 flex-1 overflow-hidden'>{children[1]}</div>
    </div>
  )
}

/** Drag handle on the sidebar's right edge — width in px, double-click resets. */
export const SideResizer = ({
  width,
  onWidth,
}: {
  readonly width: number
  readonly onWidth: (px: number) => void
}) => {
  const drag = useDrag((event: ReactPointerEvent<HTMLElement>): void => {
    onWidth(event.clientX)
  })

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowLeft') {
      onWidth(width - 16)
    } else if (event.key === 'ArrowRight') {
      onWidth(width + 16)
    }
  }

  return (
    <div
      aria-label='Resize sidebar'
      aria-orientation='vertical'
      aria-valuemax={SIDEBAR_BOUNDS.max}
      aria-valuemin={SIDEBAR_BOUNDS.min}
      aria-valuenow={Math.round(width)}
      className={`${HANDLE} border-line w-1 cursor-col-resize self-stretch border-r select-none`}
      onDoubleClick={() => {
        getSelection()?.removeAllRanges()
        onWidth(SIDEBAR_BOUNDS.fallback)
      }}
      onKeyDown={onKeyDown}
      role='separator'
      tabIndex={0}
      {...drag}
    />
  )
}
