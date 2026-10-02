import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

/** The rows of a trace block: every span under its parent (children by start), a span whose
 * parent ended elsewhere — or was never a span of this process — drawn as a root. */
export const rowsOf = (
  spans: readonly TraceDef.SpanData[],
  logs: readonly TraceDef.LogData[],
  glyphs: Helpers.Glyphs,
): Helpers.Row[] => {
  const ids = new Set(spans.map(span => span.context.spanId))
  const children = new Map<string | null, TraceDef.SpanData[]>()

  for (const span of spans.toSorted((a, b) => a.start - b.start)) {
    const parent = span.parent !== null && ids.has(span.parent.spanId) ? span.parent.spanId : null
    const siblings = children.get(parent) ?? []

    siblings.push(span)
    children.set(parent, siblings)
  }

  const logsOf = (id: string) =>
    logs.filter(log => log.context?.spanId === id).toSorted((a, b) => a.time - b.time)

  const rows: Helpers.Row[] = []
  const walk = (parent: string | null, indent: string) => {
    const level = children.get(parent) ?? []

    for (const [index, span] of level.entries()) {
      const last = index === level.length - 1
      const prefix = parent === null ? '' : `${indent}${last ? glyphs.last : glyphs.branch}`

      rows.push({ span, prefix, logs: logsOf(span.context.spanId) })
      walk(
        span.context.spanId,
        parent === null ? '' : `${indent}${last ? glyphs.gap : glyphs.line}`,
      )
    }
  }

  walk(null, '')

  return rows
}
