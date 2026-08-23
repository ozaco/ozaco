// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import { CHANGES_PREFIX } from '../const'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'
import { and, gt, gte, lt, ne } from '../utils/filter'

/**
 * The hidden per-table change log (`__changes_<table>`): one row per announced change, written
 * by the node that made it — inside its transaction (right before COMMIT) or, for a single
 * write, right before the data write. It is what makes `since: token` exact on any node and what
 * peers replay after a lost envelope. Users never see it through the handle; `Db.actions.log /
 * logStats / compact` are the only doors.
 */

const column = (
  name: string,
  kind: Spec.ColumnKind,
  extra: Partial<Spec.Column> = {},
): Spec.Column => ({
  name,
  kind,
  optional: false,
  hasDefault: false,
  enumValues: null,
  system: false,
  primary: false,
  ...extra,
})

/** The fixed schema of a table's change log. */
export const logSpecOf = (table: string): Spec.Table => ({
  name: CHANGES_PREFIX + table,
  columns: [
    column('token', 'text', { primary: true }),
    column('id', 'text'),
    column('op', 'enum', { enumValues: ['insert', 'update', 'delete', 'touch'] }),
    column('fields', 'json', { optional: true }),
    column('origin', 'text'),
    column('tx', 'text'),
    column('ts', 'int'),
  ],
  indexes: [{ name: 'by_ts', columns: ['ts'], unique: false }],
})

/** Whether a table name is reserved for change logs. */
export const isLogName = (name: string): boolean => name.startsWith('__')

const REPLAY_PAGE = 500
const TOKEN_ORDER: readonly Spec.OrderBy[] = [{ field: 'token', direction: 'asc' }]
const NEWEST_FIRST: readonly Spec.OrderBy[] = [{ field: 'token', direction: 'desc' }]

const find = (table: Spec.Table, spec: Partial<Spec.Find>) => ({
  table,
  filter: null,
  order: [],
  limit: null,
  offset: null,
  ...spec,
})

/** Append tokened writes to their tables' logs, grouped per table into one insert each. */
export function* appendLog(
  state: Helpers.Logger,
  writes: readonly Helpers.Tokened[],
  tx: string | null,
) {
  const ts = Date.now()
  const rows = new Map<string, Spec.Doc[]>()

  for (const write of writes) {
    const batch = rows.get(write.table) ?? []

    batch.push({
      token: write.token,
      id: write.id,
      op: write.op,
      fields: write.fields ?? null,
      origin: state.origin,
      tx: tx ?? write.token,
      ts,
    })
    rows.set(write.table, batch)
  }

  for (const [table, batch] of rows) {
    const log = state.logs.get(table)

    if (log) {
      yield* state.adapter.insert(log, batch)
    }
  }
}

const toEntry = (row: Spec.Doc): Database.LogEntry => ({
  token: String(row.token),
  id: String(row.id),
  op: row.op as Database.LogEntry['op'],
  fields: Array.isArray(row.fields) ? (row.fields as string[]) : null,
  origin: String(row.origin),
  tx: String(row.tx),
  ts: Number(row.ts),
})

export function* readLog(state: Helpers.Logger, log: Spec.Table, options?: Database.LogOptions) {
  const rows = yield* state.adapter.find(
    find(log, {
      filter: options?.since === undefined ? null : gt('token', options.since),
      order: TOKEN_ORDER,
      limit: Math.max(1, Math.trunc(options?.limit ?? 500)),
    }),
  )

  return rows.map(toEntry)
}

const TS_ORDER: readonly Spec.OrderBy[] = [
  { field: 'ts', direction: 'asc' },
  { field: 'token', direction: 'asc' },
]

/** Rows that became visible at or after `fromTs` (the replay floor), in visibility order —
 * paged so a long outage never pulls the whole log into memory at once. */
export function* replayLog(state: Helpers.Logger, table: string, fromTs: number) {
  const log = state.logs.get(table)

  if (!log) {
    return [] as readonly Database.LogEntry[]
  }

  const out: Database.LogEntry[] = []
  let floor = fromTs

  for (;;) {
    const rows = yield* state.adapter.find(
      find(log, { filter: gte('ts', floor), order: TS_ORDER, limit: REPLAY_PAGE }),
    )
    const entries = rows.map(toEntry).filter(entry => !out.some(seen => seen.token === entry.token))
    out.push(...entries)

    if (rows.length < REPLAY_PAGE) {
      return out as readonly Database.LogEntry[]
    }

    // next page starts at the last ts seen (duplicates on the boundary are filtered above)
    floor = Number(rows.at(-1)!.ts)
  }
}

export function* logStats(state: Helpers.Logger, log: Spec.Table) {
  const rows = yield* state.adapter.count({ table: log, filter: null })

  if (rows === 0) {
    return { rows, oldest: null, newest: null } satisfies Database.LogStats
  }

  const [oldest] = yield* state.adapter.find(find(log, { order: TOKEN_ORDER, limit: 1 }))
  const [newest] = yield* state.adapter.find(find(log, { order: NEWEST_FIRST, limit: 1 }))

  return {
    rows,
    oldest: oldest ? String(oldest.token) : null,
    newest: newest ? String(newest.token) : null,
  } satisfies Database.LogStats
}

/** Delete old rows of one log; the newest row always survives (an empty log must keep meaning
 * "never changed"). Returns the number of rows removed. */
export function* compactLog(
  state: Helpers.Logger,
  log: Spec.Table,
  options?: Database.CompactOptions,
) {
  const [newest] = yield* state.adapter.find(find(log, { order: NEWEST_FIRST, limit: 1 }))

  if (!newest) {
    return 0
  }

  const keepNewest = ne('token', String(newest.token))
  let bound: Spec.Filter

  if (options?.keep !== undefined) {
    const kept = yield* state.adapter.find(
      find(log, { order: NEWEST_FIRST, limit: Math.max(1, Math.trunc(options.keep)) }),
    )
    const last = kept.at(-1)

    if (!last) {
      return 0
    }

    bound = lt('token', String(last.token))
  } else if (options?.before instanceof Date) {
    bound = lt('ts', options.before.getTime())
  } else if (typeof options?.before === 'string') {
    bound = lt('token', options.before)
  } else {
    // no bound: everything but the newest row
    bound = keepNewest
  }
  const removed = yield* state.adapter.remove({ table: log, filter: and(bound, keepNewest) })

  return removed.length
}

/**
 * Decide what a watcher resuming from `since` must do. The log is the truth; `ts` (≈ commit
 * time) is the axis, not token order — a transaction that minted an older token but committed
 * later still shows up because its row's `ts` is recent.
 * - `'skip'`: nothing happened after `since` (outside the replay window) — no initial emission
 * - `'recompute'`: rows exist after it (or `since` is inside the window, where a concurrent
 *   late commit may still land) — one initial emission
 * - `'snapshot'`: `since` predates the retained log (compacted) or is unreadable — full emission
 */
export function* resolveSince(
  state: Helpers.Logger,
  log: Spec.Table,
  since: string,
): Operation<'skip' | 'recompute' | 'snapshot'> {
  const decoded = yield* attempt(() => IO.actions.decodeHlc(since))

  if (isFailure(decoded)) {
    return 'snapshot'
  }

  const stats = yield* logStats(state, log)

  if (stats.oldest === null) {
    return 'skip'
  }

  if (since < stats.oldest) {
    return 'snapshot'
  }

  const floor = decoded.value.ts - state.replayWindowMs

  const later = yield* state.adapter.find(
    find(log, { filter: and(gte('ts', floor), ne('token', since)), limit: 1 }),
  )

  return later.length > 0 ? 'recompute' : 'skip'
}
