// oxlint-disable import/exports-last

import type { Spec } from 'db:core'
import { DbClient, stripSystem, where } from 'db:core'
import type { ObserveDef, ServerDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, scoped, suspend, useScope, withResolvers, within } from 'std:effect'
import type { Plugin } from 'std:plugin'
import { isUse } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { Trace } from 'std:trace'

import type { Helpers } from '../types/helpers'
import type { ObservePluginDef } from '../types/observe'
import { logRowOf, spanRowOf } from '../utils/rows'
import { observeLogs, observeSpans, observeTables } from '../utils/tables'

/**
 * Open the store in ITS OWN scope: a private `DbClient` over the app's adapter (or the given
 * one), so its contexts never shadow the app's `ctx.db`. The scope is SUPPRESSED first thing —
 * the store's db work (inserts, queries, deletes) is never telemetry, whoever asks for it. Work
 * reaches it through {@link exec}; the scope ends with the plugin's.
 */
export function* openStore(
  state: ObservePluginDef.State,
  adapter: ServerDef.PluginLike | undefined,
): Operation<void> {
  const ready = withResolvers<ObservePluginDef.OpenStore>('observe store')

  yield* fork(() =>
    scoped(() =>
      Trace.actions.suppressed(function* () {
        if (adapter) {
          yield* isUse(adapter) ? adapter : (adapter as Plugin<AnyType, [], AnyType>).use()
        }

        // `safe`: this client shares the adapter with the app's — it must never drop what it does
        // not declare (the app's tables, an older deployment's `_ob_*`, are leftovers to it)
        const opened = yield* attempt(() =>
          DbClient.use({ tables: [...observeTables], safe: true }),
        )

        if (isFailure(opened)) {
          ready.reject(opened)

          return
        }

        ready.resolve({ scope: yield* useScope(), db: opened.value as Helpers.Db })
        yield* suspend()
      }),
    ),
  )

  state.store = yield* ready.operation
}

/**
 * Run `body` against the store IN the store's scope (its db, its suppression) while the caller
 * owns it: halting the caller halts it, its failure reaches only the caller.
 */
export function* exec<T>(
  state: ObservePluginDef.State,
  body: (db: Helpers.Db) => Operation<T>,
): Operation<T> {
  const store = state.store

  if (!store) {
    return yield* fail(ServerErrors.Unavailable, 'the observe store is not open')
  }

  return yield* within(store.scope, () => body(store.db))
}

/** A row as it is inserted: null → undefined (optional columns take absence, not null). Every
 * value is json-safe as it comes: std:trace spells non-finite numbers out as strings (`'NaN'`,
 * `'Infinity'`) once, before any sink sees the record. */
const clean = (row: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? undefined]))

/**
 * Write one batch of observed events: every span one `_ob2_spans` row, every log record one
 * `_ob2_logs` row, one insert per table. A failing insert never takes the server down: its rows
 * are dropped (counted in `stats().dropped`); the root span rows that landed go to the watchers.
 */
export function* writeBatch(
  state: ObservePluginDef.State,
  db: Helpers.Db,
  batch: readonly ObserveDef.Event[],
): Operation<void> {
  const spans: ObserveDef.SpanRow[] = []
  const logs: ObserveDef.LogRow[] = []

  for (const event of batch) {
    if (event.t === 'span') {
      spans.push(spanRowOf(event.span, event.resource))
    } else {
      logs.push(logRowOf(event.log, event.resource))
    }
  }

  if (logs.length > 0) {
    const kept = yield* attempt(() => db.insertMany(observeLogs.name, logs.map(clean) as AnyType))

    if (isFailure(kept)) {
      state.stats.dropped += logs.length
    }
  }

  if (spans.length === 0) {
    return
  }

  const written = yield* attempt(() =>
    db.insertMany(observeSpans.name, spans.map(clean) as AnyType),
  )

  if (isFailure(written)) {
    state.stats.dropped += spans.length

    return
  }

  const roots = spans.filter(row => row.root)

  if (roots.length === 0) {
    return
  }

  for (const watcher of state.watchers) {
    watcher(roots)
  }
}

/** Write a batch into this node's store — never failing: a batch the store cannot take (it is
 * closed, the insert failed) is counted as dropped. */
export function* writeLocal(
  state: ObservePluginDef.State,
  batch: readonly ObserveDef.Event[],
): Operation<void> {
  const written = yield* attempt(() => exec(state, db => writeBatch(state, db, batch)))

  if (isFailure(written)) {
    state.stats.dropped += batch.length
  }
}

// --- reading --------------------------------------------------------------------------------------

const SPAN_OPTIONAL = [
  'parent_span_id',
  'scope_version',
  'status_message',
  'error_type',
  'http_route',
  'http_status',
  'request_id',
  'trace_state',
] as const

const LOG_OPTIONAL = [
  'trace_id',
  'span_id',
  'flags',
  'severity_text',
  'event_name',
  'scope_version',
] as const

/** A stored document as the API shape: no system fields, absent optionals as `null`. */
const readRow = <T>(doc: Spec.Doc, optional: readonly string[]): T => {
  const row: Record<string, unknown> = { ...stripSystem(doc) }

  for (const key of optional) {
    row[key] ??= null
  }

  return row as T
}

const spanFrom = (doc: Spec.Doc): ObserveDef.SpanRow => {
  const row = readRow<ObserveDef.SpanRow>(doc, SPAN_OPTIONAL)

  // a boolean column reads back as a number on some adapters
  return { ...row, root: Boolean(row.root) }
}

const logFrom = (doc: Spec.Doc): ObserveDef.LogRow => readRow<ObserveDef.LogRow>(doc, LOG_OPTIONAL)

/** Plain code-unit order of two ids (lowercase hex: their numeric order) — no locale rules. */
const byId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** Sort a trace's spans: start order; the same instant → parents before children, then by span id
 * (never the order the rows happened to be written in). */
const inTreeOrder = (spans: readonly ObserveDef.SpanRow[]): readonly ObserveDef.SpanRow[] => {
  const parents = new Map(spans.map(span => [span.span_id, span.parent_span_id]))

  const depthOf = (id: string): number => {
    let depth = 0
    let at = parents.get(id) ?? null

    while (at !== null && parents.has(at) && depth < 64) {
      depth += 1
      at = parents.get(at) ?? null
    }

    return depth
  }

  return spans.toSorted(
    (left, right) =>
      left.start - right.start ||
      depthOf(left.span_id) - depthOf(right.span_id) ||
      byId(left.span_id, right.span_id),
  )
}

/** One trace: its spans (tree order) and log records (time order); `null` when none is stored. */
export function* traceView(
  db: Helpers.Db,
  traceId: string,
): Operation<ObserveDef.TraceView | null> {
  const spans = yield* db
    .query(observeSpans.name)
    .filter(where.eq('trace_id', traceId))
    .order('start', 'asc')
    .collect()

  const logs = yield* db
    .query(observeLogs.name)
    .filter(where.eq('trace_id', traceId))
    .order('time', 'asc')
    .collect()

  if (spans.length === 0 && logs.length === 0) {
    return null
  }

  return { trace_id: traceId, spans: inTreeOrder(spans.map(spanFrom)), logs: logs.map(logFrom) }
}

/** The trace a request id belongs to: a span carrying it (`ozaco.request.id`), else the id is
 * read as a trace id (a request id minted here IS the trace id). */
export function* requestView(db: Helpers.Db, id: string): Operation<ObserveDef.TraceView | null> {
  const carrying = yield* db.query(observeSpans.name).filter(where.eq('request_id', id)).first()

  return yield* traceView(db, carrying ? String(carrying['trace_id']) : id)
}

const filtersOf = (query: ObserveDef.TracesQuery): Spec.Filter[] => {
  const filters: Spec.Filter[] = [where.eq('root', true)]

  if (query.name !== undefined) {
    filters.push(where.eq('name', query.name))
  }

  if (query.route !== undefined) {
    filters.push(where.eq('http_route', query.route))
  }

  if (query.service !== undefined) {
    filters.push(where.eq('service_name', query.service))
  }

  if (query.status === 'ok') {
    filters.push(where.isNull('error_type'))
  }

  if (query.status === 'failed') {
    filters.push(where.notNull('error_type'))
  }

  if (query.status === 'error') {
    filters.push(where.eq('status_code', 'error'))
  }

  if (query.errorType !== undefined) {
    filters.push(where.eq('error_type', query.errorType))
  }

  if (query.slowerThan !== undefined) {
    filters.push(where.gt('duration_ms', query.slowerThan))
  }

  if (query.since !== undefined) {
    filters.push(where.gte('start', query.since))
  }

  return filters
}

/** Whether a root row passes a query — the in-memory twin of {@link filtersOf} (`watch`). */
export const matchesQuery = (row: ObserveDef.SpanRow, query: ObserveDef.TracesQuery): boolean =>
  row.root &&
  (query.name === undefined || row.name === query.name) &&
  (query.route === undefined || row.http_route === query.route) &&
  (query.service === undefined || row.service_name === query.service) &&
  (query.status !== 'ok' || row.error_type === null) &&
  (query.status !== 'failed' || row.error_type !== null) &&
  (query.status !== 'error' || row.status_code === 'error') &&
  (query.errorType === undefined || row.error_type === query.errorType) &&
  (query.slowerThan === undefined || row.duration_ms > query.slowerThan) &&
  (query.since === undefined || row.start >= query.since)

const cursorOf = (at: Helpers.TracePosition): string => `${at.spanId}@${at.start}`

const positionOf = (cursor: string): Helpers.TracePosition | null => {
  const at = cursor.lastIndexOf('@')
  const start = Number(cursor.slice(at + 1))

  return at > 0 && cursor.slice(at + 1).length > 0 && Number.isFinite(start)
    ? { start, spanId: cursor.slice(0, at) }
    : null
}

/** The rows listed after `at` (newest first: an older start, or the same start and a lower span
 * id). */
const after = (at: Helpers.TracePosition): Spec.Filter =>
  where.or(
    where.lt('start', at.start),
    where.and(where.eq('start', at.start), where.lt('span_id', at.spanId)),
  )

/** How a local root ranks as the one its trace is listed by: 0 = no parent (THE root), 1 = its
 * remote parent is not stored (the outermost part of the trace the store has), 2 = its parent is
 * stored (a hop inside a trace the store holds more of). */
const rankOf = (row: ObserveDef.SpanRow, stored: ReadonlySet<string>): number =>
  row.parent_span_id === null ? 0 : stored.has(`${row.trace_id}/${row.parent_span_id}`) ? 2 : 1

/**
 * The root each of `traceIds` is listed by, among its roots that pass the query: the best
 * {@link rankOf}, then the earliest start, then the lower span id — never the order the rows were
 * written in, and never the clock alone (a remote child's start can precede its parent's by the
 * skew between two nodes).
 */
function* listedRoots(
  db: Helpers.Db,
  matching: Spec.Filter,
  traceIds: readonly string[],
): Operation<ReadonlyMap<string, ObserveDef.SpanRow>> {
  const roots = (yield* db
    .query(observeSpans.name)
    .filter(where.and(matching, where.oneOf('trace_id', traceIds)))
    .collect()).map(spanFrom)
  const parents = [
    ...new Set(roots.flatMap(row => (row.parent_span_id === null ? [] : [row.parent_span_id]))),
  ]
  const found =
    parents.length === 0
      ? []
      : yield* db
          .query(observeSpans.name)
          .filter(where.and(where.oneOf('trace_id', traceIds), where.oneOf('span_id', parents)))
          .collect()
  const stored = new Set(found.map(doc => `${String(doc['trace_id'])}/${String(doc['span_id'])}`))
  const listed = new Map<string, ObserveDef.SpanRow>()

  const before = (row: ObserveDef.SpanRow, other: ObserveDef.SpanRow): boolean =>
    (rankOf(row, stored) - rankOf(other, stored) ||
      row.start - other.start ||
      byId(row.span_id, other.span_id)) < 0

  for (const row of roots) {
    const best = listed.get(row.trace_id)

    if (!best || before(row, best)) {
      listed.set(row.trace_id, row)
    }
  }

  return listed
}

/** How many root rows one read of the trace walk takes. */
const WALK_CHUNK = 200

/**
 * One row per trace, newest first, cursor-paged: a trace that entered several stored services
 * (the gateway's edge span, a service node's carrier span — local roots both) is listed ONCE, by
 * its {@link listedRoots} pick, at that row's place. The dedupe happens BEFORE paging — the walk
 * over the matching roots skips every row that is not its trace's pick — so a trace is never
 * split across two pages and a page holds `limit` traces while there are more. Deterministic:
 * roots of the same instant are ordered by span id, descending. The cursor is the position of the
 * last row walked.
 */
export function* queryTraces(
  db: Helpers.Db,
  query: ObserveDef.TracesQuery,
): Operation<ObserveDef.TracesPage> {
  const limit = Math.max(1, Math.min(500, query.limit ?? 50))
  const matching = where.and(...filtersOf(query))
  let walked = query.cursor === undefined ? null : positionOf(query.cursor)

  if (query.cursor !== undefined && walked === null) {
    return yield* fail(ServerErrors.Validation, `observe: not a trace cursor: ${query.cursor}`)
  }

  const traces: ObserveDef.SpanRow[] = []
  const picks = new Map<string, ObserveDef.SpanRow>()

  for (;;) {
    const rows = (yield* db
      .query(observeSpans.name)
      .filter(walked === null ? matching : where.and(matching, after(walked)))
      .order('start', 'desc')
      .order('span_id', 'desc')
      .take(WALK_CHUNK)).map(spanFrom)
    const unseen = [...new Set(rows.map(row => row.trace_id))].filter(id => !picks.has(id))

    if (unseen.length > 0) {
      for (const [traceId, row] of yield* listedRoots(db, matching, unseen)) {
        picks.set(traceId, row)
      }
    }

    for (const row of rows) {
      if (picks.get(row.trace_id)?.span_id === row.span_id) {
        // a trace more than this page holds: the next page starts right after the last row walked
        if (traces.length === limit) {
          return { traces, cursor: cursorOf(walked!) }
        }

        traces.push(row)
      }

      walked = { start: row.start, spanId: row.span_id }
    }

    if (rows.length < WALK_CHUNK) {
      return { traces, cursor: null }
    }
  }
}

/** The spans the cluster view measures, since `since`: server / client spans and local roots. */
export function* clusterSpans(
  db: Helpers.Db,
  since: number,
): Operation<readonly ObserveDef.SpanRow[]> {
  const rows = yield* db
    .query(observeSpans.name)
    .filter(
      where.and(
        where.gte('start', since),
        where.or(where.oneOf('kind', ['server', 'client']), where.eq('root', true)),
      ),
    )
    .collect()

  return rows.map(spanFrom)
}

/** An exception log record (`…exception` event name) — kept as long as the spans. */
const exception = where.like('event_name', '%exception')

/**
 * Delete what is older than its floor: spans and exception records before `spans`, every other
 * log record before `logs`. Resolves how many rows went.
 */
export function* pruneBefore(
  db: Helpers.Db,
  floors: { readonly spans: number; readonly logs: number },
): Operation<number> {
  const plan: readonly [string, Spec.Filter][] = [
    [observeSpans.name, where.lt('start', floors.spans)],
    [observeLogs.name, where.and(where.lt('time', floors.spans), exception)],
    [
      observeLogs.name,
      where.and(
        where.lt('time', floors.logs),
        where.or(where.isNull('event_name'), where.not(exception)),
      ),
    ],
  ]
  let removed = 0

  for (const [table, filter] of plan) {
    const stale = yield* db.query(table).filter(filter).collect()

    for (const row of stale) {
      if (yield* db.delete(table, String(row['_id']))) {
        removed += 1
      }
    }
  }

  return removed
}
