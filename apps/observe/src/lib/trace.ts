// oxlint-disable import/exports-last
/** The console's pure trace logic: the waterfall's tree order, the live list merge and which
 * of a span's events show inline. */
import type { LogRow, SpanEvent, SpanRow } from './api'
import { isExceptionLog } from './api'

/** One span placed in the waterfall. */
export interface Placed {
  readonly span: SpanRow
  readonly depth: number
}

/**
 * The spans in tree order (depth-first; siblings keep the store's start order). A span whose
 * parent is not in the view (a remote caller, an unstored span) starts a tree of its own; a
 * cycle (a malformed row) never loops.
 */
export const treeOf = (spans: readonly SpanRow[]): readonly Placed[] => {
  const ids = new Set(spans.map(span => span.span_id))
  const children = new Map<string | null, SpanRow[]>()

  for (const span of spans) {
    const parent =
      span.parent_span_id !== null && ids.has(span.parent_span_id) ? span.parent_span_id : null
    children.set(parent, [...(children.get(parent) ?? []), span])
  }

  const out: Placed[] = []
  const seen = new Set<string>()

  const walk = (parent: string | null, depth: number): void => {
    for (const span of children.get(parent) ?? []) {
      if (seen.has(span.span_id)) {
        continue
      }

      seen.add(span.span_id)
      out.push({ span, depth })
      walk(span.span_id, depth + 1)
    }
  }

  walk(null, 0)

  // a span only reachable through a cycle is still shown, at the top level
  for (const span of spans) {
    if (!seen.has(span.span_id)) {
      seen.add(span.span_id)
      out.push({ span, depth: 0 })
    }
  }

  return out
}

/** Whether `row` lists AFTER `other` — the store's order (`traces()`): newest start first, the
 * same start (two roots in one millisecond) by span id, higher first. */
const olderThan = (other: SpanRow, row: SpanRow): boolean =>
  other.start < row.start || (other.start === row.start && other.span_id < row.span_id)

/** Put `row` into `rows` (newest first, as the store lists them) at its place. */
const insertByStart = (rows: SpanRow[], row: SpanRow): void => {
  const at = rows.findIndex(other => olderThan(other, row))

  if (at === -1) {
    rows.push(row)
  } else {
    rows.splice(at, 0, row)
  }
}

/**
 * Whether `row` is a better root to list its trace by than `other` — the store's pick
 * (`traces()`): the root with no parent first, then the earliest start, then the lower span id.
 * (The store also ranks a root whose remote parent it holds below one whose parent it does not;
 * the live feed carries roots only, so among roots with a parent the earliest is the pick.)
 */
const listsBefore = (row: SpanRow, other: SpanRow): boolean => {
  const rank = Number(row.parent_span_id !== null) - Number(other.parent_span_id !== null)

  return (
    rank < 0 ||
    (rank === 0 &&
      (row.start < other.start || (row.start === other.start && row.span_id < other.span_id)))
  )
}

/**
 * Merge live roots into the list (newest first): ONE row per trace — its {@link listsBefore}
 * pick, so a trace that entered several stored services is listed once, by its real root even
 * when a service node's root arrived first (a child ends, and is stored, before its parent).
 * A trace whose row changed (a new trace, a better root) goes in at that row's place in the
 * store's order (start, then span id: roots of one millisecond keep one order whatever order
 * they arrived in).
 */
export const mergeLive = (
  prior: readonly SpanRow[],
  incoming: readonly SpanRow[],
): readonly SpanRow[] => {
  const listed = new Map(prior.map(row => [row.trace_id, row]))
  const changed = new Set<string>()

  for (const row of incoming) {
    const seen = listed.get(row.trace_id)

    if (!seen || listsBefore(row, seen)) {
      listed.set(row.trace_id, row)
      changed.add(row.trace_id)
    }
  }

  const rows = prior.filter(row => !changed.has(row.trace_id))

  for (const traceId of changed) {
    insertByStart(rows, listed.get(traceId)!)
  }

  return rows
}

/**
 * The events shown inline under a span. Its `exception` event and its exception RECORD are one
 * failure: with the record stored (its whole chain is its block in the failures list) the event
 * is left out here — it stays a mark on the span's bar — so every failure is rendered in full
 * exactly once. Without a stored record the event is all there is, and it shows.
 */
export const inlineEvents = (span: SpanRow, logs: readonly LogRow[]): readonly SpanEvent[] =>
  logs.some(log => log.span_id === span.span_id && isExceptionLog(log))
    ? span.events.filter(event => event.name !== 'exception')
    : span.events
