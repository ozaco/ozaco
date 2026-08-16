import type { ReactNode } from 'react'
import { Button } from 'react-aria-components'

import { BoltIcon, PlayIcon, StopIcon } from './icons'

/**
 * URL bar building blocks shared by every request type: the container row, the method/protocol
 * chip, the path display with `:params` resolved inline, and the prominent action button
 * (Send → Cancel, Connect → Disconnect).
 */

const ACTION_TONE: Record<ActionTone, string> = {
  accent:
    'bg-accent text-accent-contrast border border-accent data-hovered:opacity-90 font-semibold',
  danger: 'border border-danger/60 bg-danger/10 text-danger data-hovered:bg-danger/20',
  ok: 'border border-ok/60 bg-ok/10 text-ok data-hovered:bg-ok/20',
  warn: 'border border-post/60 bg-post/10 text-post data-hovered:bg-post/20',
}

export type ActionTone = 'accent' | 'danger' | 'ok' | 'warn'

export const UrlBarShell = ({ children }: { readonly children: ReactNode }) => (
  <div className='border-line bg-panel flex h-11 shrink-0 items-center gap-2 border-b px-2.5'>
    {children}
  </div>
)

export const MethodChip = ({
  label,
  textClass,
}: {
  readonly label: string
  readonly textClass: string
}) => (
  <span
    className={`border-line bg-surface inline-flex h-7 shrink-0 items-center justify-center rounded border px-2.5 font-mono text-[11px] font-bold tracking-wider ${textClass}`}>
    {label}
  </span>
)

/** Route path with `:param` segments resolved from the current args (accent = filled). */
export const PathDisplay = ({
  base,
  path,
  args,
}: {
  readonly base: string
  readonly path: string
  /** Parsed args record, or null when the args JSON is invalid. */
  readonly args: Readonly<Record<string, unknown>> | null
}) => {
  // positional split of one static path — the slot index IS the identity of a segment
  const segments = path
    .split(/(:[A-Za-z0-9_]+)/gu)
    .map((text, slot) => ({ id: `s${slot}`, text }))
    .filter(segment => segment.text !== '')

  return (
    <div className='border-line bg-surface flex h-7 min-w-0 flex-1 items-center overflow-x-auto rounded border px-2.5 font-mono text-[12.5px] whitespace-nowrap'>
      {base === '' ? null : <span className='text-muted shrink-0'>{base}</span>}
      {segments.map(segment => {
        if (!segment.text.startsWith(':')) {
          return (
            <span key={segment.id} className='text-ink'>
              {segment.text}
            </span>
          )
        }

        const name = segment.text.slice(1)
        const value = args?.[name]

        return value === undefined ? (
          <span key={segment.id} className='text-post' title={`missing :${name}`}>
            {segment.text}
          </span>
        ) : (
          <span key={segment.id} className='text-accent' title={`:${name}`}>
            {encodeURIComponent(String(value))}
          </span>
        )
      })}
    </div>
  )
}

export const ActionButton = ({
  label,
  tone,
  onPress,
  isDisabled = false,
  icon,
}: {
  readonly label: string
  readonly tone: ActionTone
  readonly onPress: () => void
  readonly isDisabled?: boolean
  readonly icon?: 'play' | 'stop' | 'bolt'
}) => (
  <Button
    className={`flex h-7 shrink-0 items-center gap-1.5 rounded px-3.5 text-[12.5px] data-disabled:opacity-40 ${ACTION_TONE[tone]}`}
    isDisabled={isDisabled}
    onPress={onPress}>
    {icon === 'play' ? (
      <PlayIcon />
    ) : icon === 'stop' ? (
      <StopIcon />
    ) : icon === 'bolt' ? (
      <BoltIcon />
    ) : null}
    {label}
  </Button>
)
