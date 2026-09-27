// oxlint-disable import/exports-last
/** Small render helpers shared by the console's panes. */
import type { AttrValue, SpanRow } from './api'

/** A duration in ms: sub-ms precision below 10 ms, whole ms above. */
export const fmtMs = (ms: number): string =>
  ms < 10
    ? `${ms.toFixed(2)}ms`
    : ms < 10_000
      ? `${Math.round(ms)}ms`
      : `${(ms / 1000).toFixed(1)}s`

/** A wall-clock time with milliseconds. */
export const fmtTime = (epochMs: number): string => {
  const at = new Date(epochMs)
  const ms = String(at.getMilliseconds()).padStart(3, '0')

  return `${at.toLocaleTimeString([], { hour12: false })}.${ms}`
}

/** An attribute value as one line of text. */
export const fmtValue = (value: AttrValue | undefined): string =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)

/** OTel severity number → its range name. */
export const severityOf = (severity: number): string =>
  severity >= 21
    ? 'fatal'
    : severity >= 17
      ? 'error'
      : severity >= 13
        ? 'warn'
        : severity >= 9
          ? 'info'
          : severity >= 5
            ? 'debug'
            : 'trace'

export const severityColor = (severity: number): string =>
  severity >= 17 ? 'var(--bad)' : severity >= 13 ? 'var(--warn)' : 'var(--dim)'

const PALETTE = ['#7aa2f7', '#bb9af7', '#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#73daca']

/** A stable color per service name (the badge and the waterfall bar). */
export const serviceColor = (name: string): string => {
  let hash = 0

  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) | 0
  }

  return PALETTE[Math.abs(hash) % PALETTE.length]!
}

/** How a span ended: an error status (5xx-class), a failure that left it unset (4xx-class), or
 * fine. */
export const outcomeOf = (span: SpanRow): 'error' | 'failed' | 'ok' =>
  span.status_code === 'error' ? 'error' : span.error_type === null ? 'ok' : 'failed'

export const outcomeColor = (span: SpanRow): string => {
  const outcome = outcomeOf(span)

  return outcome === 'error' ? 'var(--bad)' : outcome === 'failed' ? 'var(--warn)' : 'var(--ok)'
}

/** The status column of a root: its HTTP status, else its error type, else `ok`. */
export const statusText = (span: SpanRow): string =>
  span.http_status === null ? (span.error_type ?? 'ok') : String(span.http_status)
