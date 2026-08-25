// oxlint-disable import/exports-last
/** A frame/event log that follows the tail until the user scrolls up. */
import { useEffect, useRef, useState } from 'react'

export interface Line {
  readonly at: number
  readonly tone: 'in' | 'out' | 'info' | 'error'
  readonly text: string
}

const TONES: Record<Line['tone'], string> = {
  in: 'var(--ok)',
  out: 'var(--accent)',
  info: 'var(--dim)',
  error: 'var(--bad)',
}

export const Timeline = ({ lines }: { lines: readonly Line[] }) => {
  const host = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  useEffect(() => {
    if (follow && host.current) {
      host.current.scrollTop = host.current.scrollHeight
    }
  }, [lines, follow])
  return (
    <div className='relative h-full'>
      <div
        ref={host}
        className='mono h-full overflow-auto p-2'
        onScroll={event => {
          const element = event.currentTarget
          setFollow(element.scrollTop + element.clientHeight >= element.scrollHeight - 4)
        }}>
        {lines.length === 0 && <div style={{ color: 'var(--dim)' }}>nothing yet</div>}
        {lines.map((line, index) => (
          <div key={index} className='flex gap-2 break-all whitespace-pre-wrap'>
            <span style={{ color: 'var(--dim)', flexShrink: 0 }}>
              {line.at.toFixed(0).padStart(6)}ms
            </span>
            <span style={{ color: TONES[line.tone], flexShrink: 0 }}>
              {line.tone === 'in' ? '←' : line.tone === 'out' ? '→' : '·'}
            </span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
      {!follow && (
        <button className='btn absolute right-3 bottom-2' onClick={() => setFollow(true)}>
          ↓ follow
        </button>
      )}
    </div>
  )
}
