import { useEffect, useRef, useState } from 'react'
import { Button } from 'react-aria-components'

/**
 * Chronological color-coded event log (frames, SSE events, request lifecycle) with follow-scroll:
 * new entries keep the pane pinned to the bottom until the user scrolls up, which pauses the
 * follow; a floating button resumes it.
 */

const TONE_CLASS: Record<TimelineTone, string> = {
  in: 'text-ink',
  out: 'text-accent',
  sys: 'text-muted',
  err: 'text-danger',
  sync: 'text-ok',
  delta: 'text-put',
  reset: 'text-post',
}

const stamp = (at: number): string => new Date(at).toISOString().slice(11, 23)

export type TimelineTone = 'in' | 'out' | 'sys' | 'err' | 'sync' | 'delta' | 'reset'

export interface TimelineEntry {
  readonly at: number
  readonly tone: TimelineTone
  readonly text: string
}

export const Timeline = ({
  entries,
  empty = 'Nothing yet',
}: {
  readonly entries: readonly TimelineEntry[]
  readonly empty?: string
}) => {
  const pane = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    const node = pane.current

    if (node !== null && following) {
      node.scrollTop = node.scrollHeight
    }
  }, [entries, following])

  const onScroll = (): void => {
    const node = pane.current

    if (node !== null) {
      setFollowing(node.scrollTop + node.clientHeight >= node.scrollHeight - 12)
    }
  }

  return (
    <div className='relative h-full min-h-0'>
      <div
        ref={pane}
        className='h-full overflow-auto p-2 font-mono text-[12px] leading-5'
        onScroll={onScroll}
        role='log'>
        {entries.length === 0 ? (
          <div className='text-muted p-2'>{empty}</div>
        ) : (
          entries.map((entry, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- append-only log
            <div key={index} className='flex gap-2'>
              <span className='text-muted shrink-0 select-none'>{stamp(entry.at)}</span>
              <span
                className={`w-10 shrink-0 text-right opacity-70 select-none ${TONE_CLASS[entry.tone]}`}>
                {entry.tone}
              </span>
              <span className={`min-w-0 break-all whitespace-pre-wrap ${TONE_CLASS[entry.tone]}`}>
                {entry.text}
              </span>
            </div>
          ))
        )}
      </div>
      {following ? null : (
        <Button
          className='border-line bg-panel text-muted data-hovered:text-ink absolute right-3 bottom-2 rounded border px-2 py-0.5 text-[11px] shadow-md'
          onPress={() => setFollowing(true)}>
          Resume follow ↓
        </Button>
      )}
    </div>
  )
}
