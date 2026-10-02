import type { PaletteDef } from 'cli:palette'
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

import { DURATION_COLUMNS, EXCEPTION_TYPE, KIND_COLOR, SEVERITIES } from './const'

/** One scalar as printed: a string JSON-quoted unless it is one word. */
const scalar = (item: string | number | boolean): string =>
  typeof item === 'string' && !/^[^\s"=]+$/u.test(item) ? JSON.stringify(item) : String(item)

/** Wall-clock time of day (UTC) with milliseconds. */
export const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 23)

/** `0.42ms` / `12.40ms` / `1.23s`, right-aligned to the duration column. */
export const duration = (ms: number): string => {
  const text = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.max(0, ms).toFixed(2)}ms`

  return text.padStart(DURATION_COLUMNS)
}

/** `text` cut to `width` with an ellipsis, or padded to it. */
export const fit = (text: string, width: number, unicode: boolean): string =>
  text.length > width
    ? `${text.slice(0, Math.max(0, width - 1))}${unicode ? '…' : '~'}`
    : text.padEnd(width)

/** OTel severity number → its range's name (TRACE 1-4, DEBUG 5-8, … FATAL 21-24). */
export const severityOf = (log: TraceDef.LogData): string =>
  SEVERITIES[
    Math.min(SEVERITIES.length - 1, Math.max(0, Math.floor((log.severityNumber - 1) / 4)))
  ] ?? String(log.severityNumber)

/** The palette style of a record's severity: error at ERROR+, warning at WARN, muted below. */
export const severityStyle = (severity: number, colors: PaletteDef.Colors): PaletteDef.Style =>
  severity >= 17 ? colors.error : severity >= 13 ? colors.warning : colors.muted

export const isException = (log: TraceDef.LogData): boolean =>
  log.attributes[EXCEPTION_TYPE] !== undefined

/** The bar's style: error when the span failed, warning when a failure passed through it
 * (`error.type` without a status), else its kind's colour. */
export const barStyle = (span: TraceDef.SpanData, colors: PaletteDef.Colors): PaletteDef.Style =>
  span.status.code === 'error'
    ? colors.error
    : span.attributes['error.type'] === undefined
      ? colors[KIND_COLOR[span.kind]]
      : colors.warning

/** Attributes as ` key=value` tokens (`skip` left out), empty when none remain. */
export const tokens = (attributes: TraceDef.Attributes, skip: ReadonlySet<string>): string => {
  const parts = Object.entries(attributes)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key}=[${(value as readonly (string | number | boolean)[]).map(scalar).join(',')}]`
        : `${key}=${scalar(value as string | number | boolean)}`,
    )

  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/** A row's label: its name, `@service` added when that is not the block's. */
export const labelOf = (row: Helpers.Row, service: string | null): string =>
  row.span.service !== null && row.span.service !== service
    ? `${row.span.name} @${row.span.service}`
    : row.span.name
