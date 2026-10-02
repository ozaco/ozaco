import type { PaletteDef } from 'cli:palette'
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

import { barOf } from './bar'
import { EVENT_KEYS, KIND_COLUMNS } from './const'
import {
  clock,
  duration,
  fit,
  isException,
  labelOf,
  severityOf,
  severityStyle,
  tokens,
} from './format'
import { glyphsOf } from './layout'

/** `ok`, `✗ <error.type>` (a failure that did not fail the span — a 4xx, a handled one) or
 * `✗ <error.type>: <message>` (status error). */
const outcomeOf = (span: TraceDef.SpanData, layout: Helpers.Layout): string => {
  const { colors } = layout.palette
  const type = span.attributes['error.type']

  if (span.status.code === 'error') {
    const message = span.status.message ? `: ${span.status.message}` : ''

    return colors.error(
      `${layout.glyphs.failed} ${type === undefined ? 'error' : String(type)}${message}`,
    )
  }

  return type === undefined
    ? colors.dim('ok')
    : colors.warning(`${layout.glyphs.failed} ${String(type)}`)
}

/** A record's text: its body — an event record whose body is only its name shows its
 * attributes instead. */
const bodyOf = (log: TraceDef.LogData): string =>
  log.eventName !== undefined && log.body === log.eventName
    ? tokens(log.attributes, EVENT_KEYS).trimStart()
    : log.body

/** `text` cut to `width` (an ellipsis closing it) — a record's attributes can run on for
 * hundreds of columns; the timeline keeps every line on the screen. */
const cut = (text: string, width: number, unicode: boolean): string =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}${unicode ? '…' : '~'}` : text

/** `<indent><glyph> <when> SEVERITY [event] <scope: ><first line>`, then an exception's
 * remaining chain lines; every line cut to the width. */
const recordLines = (
  log: TraceDef.LogData,
  place: { when: string; indent: string; scope?: string },
  look: { palette: PaletteDef.Context; glyphs: Helpers.Glyphs; width: number },
): string[] => {
  const { colors, unicode } = look.palette
  const severity = severityStyle(log.severityNumber, colors)(severityOf(log))
  const event = log.eventName ? ` [${log.eventName}]` : ''
  const scope = place.scope === undefined ? '' : `${place.scope}: `
  const [head = '', ...rest] = bodyOf(log).split('\n')
  // the lead is cut on its plain text, then styled — an escape must never be cut in half
  const plain = `${place.indent}${look.glyphs.record} ${place.when} ${severityOf(log)}${event} ${scope}${head}`
  const room = look.width - (plain.length - head.length)
  const lead = `${place.indent}${look.glyphs.record} ${colors.dim(place.when)} ${severity}${event} ${scope}${cut(head, room, unicode)}`

  return isException(log)
    ? [
        lead,
        ...rest.map(
          line =>
            `${place.indent}  ${colors.error(cut(line, look.width - place.indent.length - 2, unicode))}`,
        ),
      ]
    : [lead]
}

/** `<prefix><name> KIND     ▕<bar>▏ <duration> <outcome>`. */
export const spanLine = (row: Helpers.Row, layout: Helpers.Layout): string => {
  const { colors, unicode } = layout.palette
  const label = fit(`${row.prefix}${labelOf(row, layout.service)}`, layout.label, unicode)
  const kind = colors.dim(row.span.kind.toUpperCase().padEnd(KIND_COLUMNS))
  const time = colors.dim(duration(row.span.end - row.span.start))
  const bar = `${layout.glyphs.open}${barOf(row, layout)}${layout.glyphs.close}`

  return `${label} ${kind} ${bar} ${time} ${outcomeOf(row.span, layout)}`
}

/** A record under its span, its time as an offset from the block's origin. */
export const logLines = (log: TraceDef.LogData, indent: string, layout: Helpers.Layout): string[] =>
  recordLines(
    log,
    {
      when: `${log.time < layout.origin ? '-' : '+'}${Math.abs(log.time - layout.origin).toFixed(2)}ms`,
      indent,
    },
    layout,
  )

/** `━━ <root name> · <service> · N spans · <total> · <clock> ━━━… <trace id>`: the rule fills
 * the width, the id sits at its end (and is the first thing a narrow line loses). */
export const headerLine = (rows: readonly Helpers.Row[], layout: Helpers.Layout): string => {
  const [root] = rows
  const { rule } = layout.glyphs
  const { bold, dim } = layout.palette.colors
  const parts = [
    ...(root ? [root.span.name] : []),
    ...(layout.service === null ? [] : [layout.service]),
    `${rows.length} span${rows.length === 1 ? '' : 's'}`,
    duration(layout.extent).trim(),
    clock(layout.origin),
  ]
  const title = `${rule}${rule} ${parts.join(layout.palette.unicode ? ' · ' : ' | ')} `
  const id = root?.span.context.traceId ?? ''
  const room = layout.width - title.length - id.length - 1
  const tail =
    room >= 2
      ? `${rule.repeat(room)} ${dim(id)}`
      : rule.repeat(Math.max(0, layout.width - title.length))

  return `${bold(title)}${tail}`.trimEnd()
}

/** A one-span trace as ONE line — no axis to draw: `▪ <clock> <name> KIND <duration> <outcome>
 * <trace id>`; its records follow as usual. */
export const singleLine = (row: Helpers.Row, layout: Helpers.Layout): string => {
  const { colors } = layout.palette
  const kind = colors.dim(row.span.kind.toUpperCase())
  const time = colors.dim(duration(row.span.end - row.span.start).trim())
  const name = labelOf(row, null)

  return `${layout.glyphs.single} ${colors.dim(clock(row.span.start))} ${name} ${kind} ${time} ${outcomeOf(row.span, layout)} ${colors.dim(row.span.context.traceId)}`
}

/** A record outside every trace, as one line with its wall-clock time and scope. */
export const strayLines = (
  log: TraceDef.LogData,
  look: { palette: PaletteDef.Context; width: number },
): string[] =>
  recordLines(
    log,
    { when: clock(log.time), indent: '', scope: log.scope.name },
    { ...look, glyphs: glyphsOf(look.palette) },
  )
