// oxlint-disable import/exports-last
/** Resizable panes: a vertical splitter (request | response) that stacks on narrow viewports,
 * and a side resizer for the sidebar. Pointer-capture drag, double-click resets, persisted. */
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { storage } from '../lib/config'

interface Persisted {
  readonly key: string
  readonly fallback: number
  readonly min: number
  readonly max: number
}

export const usePersistedNumber = ({ key, fallback, min, max }: Persisted) => {
  const [value, setValue] = useState(() => {
    const stored = Number(storage.get(key))
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : fallback
  })
  const update = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(min, next))
      setValue(clamped)
      storage.set(key, String(clamped))
    },
    [key, min, max],
  )
  return [value, update, () => update(fallback)] as const
}

export const useStacked = (breakpoint = 1000): boolean => {
  const [stacked, setStacked] = useState(() => window.innerWidth <= breakpoint)
  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const listen = () => setStacked(media.matches)
    media.addEventListener('change', listen)
    return () => media.removeEventListener('change', listen)
  }, [breakpoint])
  return stacked
}

interface SplitProps {
  readonly left: ReactNode
  readonly right: ReactNode
  readonly storageKey: string
}

export const SplitLayout = ({ left, right, storageKey }: SplitProps) => {
  const [percent, setPercent, reset] = usePersistedNumber({
    key: storageKey,
    fallback: 50,
    min: 25,
    max: 75,
  })
  const stacked = useStacked()
  const host = useRef<HTMLDivElement>(null)
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = host.current
    if (!element) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = element.getBoundingClientRect()
    const move = (moveEvent: PointerEvent) => {
      const ratio = stacked
        ? (moveEvent.clientY - rect.top) / rect.height
        : (moveEvent.clientX - rect.left) / rect.width
      setPercent(Math.round(ratio * 100))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      ref={host}
      className='flex h-full min-h-0 w-full'
      style={{ flexDirection: stacked ? 'column' : 'row' }}>
      <div
        className='min-h-0 min-w-0 overflow-hidden'
        style={{ flexBasis: `${percent}%`, flexGrow: 0, flexShrink: 0 }}>
        {left}
      </div>
      <div
        role='separator'
        aria-orientation={stacked ? 'horizontal' : 'vertical'}
        onPointerDown={drag}
        onDoubleClick={reset}
        className='shrink-0'
        style={{
          cursor: stacked ? 'row-resize' : 'col-resize',
          width: stacked ? '100%' : 5,
          height: stacked ? 5 : '100%',
          background: 'var(--line)',
        }}
      />
      <div className='min-h-0 min-w-0 flex-1 overflow-hidden'>{right}</div>
    </div>
  )
}

export const SideResizer = ({
  onResize,
  onReset,
}: {
  onResize: (width: number) => void
  onReset: () => void
}) => (
  <div
    role='separator'
    aria-orientation='vertical'
    onDoubleClick={onReset}
    onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId)
      const move = (moveEvent: PointerEvent) => onResize(moveEvent.clientX)
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }}
    className='h-full w-[5px] shrink-0 cursor-col-resize'
    style={{ background: 'var(--line)' }}
  />
)
