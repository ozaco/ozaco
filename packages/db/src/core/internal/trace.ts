// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import type { Result } from 'std:result'
import { isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { CHANGES_PREFIX, TELEMETRY_SCOPE } from '../const'
import { Kv } from '../definition/protocol'
import type { Adapter } from '../types/adapter'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { KvDef } from '../types/kv'
import type { Spec } from '../types/spec'
import { adapterIdentity } from '../utils/telemetry'

import { DB_EXCEPTION_EVENT, MEMORY_SYSTEM, STATUS_CODE_DEPTH, TX_RETRY_EVENT } from './const'
import { InKv, QueryText } from './context'
import { statusCodeIn } from './driver'

/** `db.response.status_code` of a failed call: the driver code the first status cause names
 * (`sqlstate 23505`, `sqlite SQLITE_BUSY` — what an adapter appends, `driverCause`) in the failure
 * or the failures nested in its causes — a level's own string causes before the levels under it,
 * depth first; cycle-safe and at most {@link STATUS_CODE_DEPTH} levels deep. */
const statusCodeOf = (failure: Result.Failure<unknown>): string | undefined => {
  const seen = new Set<unknown>()

  const visit = (level: Result.Failure<unknown>, depth: number): string | undefined => {
    if (seen.has(level) || !Array.isArray(level.causes)) {
      return undefined
    }

    seen.add(level)

    for (const cause of level.causes) {
      const code = typeof cause === 'string' ? statusCodeIn(cause) : undefined

      if (code) {
        return code
      }
    }

    if (depth >= STATUS_CODE_DEPTH) {
      return undefined
    }

    for (const cause of level.causes) {
      const nested = isFailure(cause) ? visit(cause, depth + 1) : undefined

      if (nested) {
        return nested
      }
    }

    return undefined
  }

  return visit(failure, 1)
}

const identityAttributes = (identity: Helpers.DbIdentity): TraceDef.AttributesInput => ({
  'db.system.name': identity.system,
  'db.namespace': identity.namespace,
  'server.address': identity.address,
  'server.port': identity.port,
})

/**
 * Run one adapter call in its db span — CHILD-ONLY (`requireParent`: without a recording parent
 * there is no span and no cost beyond a context read), none under a Kv span. The span is named
 * `{op} {table}`; it collects the statement texts the SQL layer notes, the driver's status code on
 * a failure and — opt-in — the returned row count.
 */
function* dbSpan<T>(
  identity: Helpers.DbIdentity,
  call: Helpers.DbCall<T>,
  body: () => Operation<T>,
): Operation<T> {
  if (yield* InKv.get()) {
    return yield* body()
  }

  const options: TraceDef.SpanOptions = {
    kind: identity.kind,
    scope: TELEMETRY_SCOPE,
    requireParent: true,
    attributes: {
      ...identityAttributes(identity),
      'db.collection.name': call.table,
      'db.operation.name': call.op,
      'db.operation.batch.size':
        call.batch !== undefined && call.batch > 1 ? call.batch : undefined,
    },
    failure: { eventName: DB_EXCEPTION_EVENT },
  }

  return yield* Trace.actions.span(
    call.table ? `${call.op} ${call.table}` : call.op,
    options,
    function* (handle) {
      if (!handle.recording) {
        return yield* body()
      }

      // a data-plane call collects its own statements; anything else (a transaction's body) runs
      // with no collector, so nothing leaks into an outer span's text
      const texts: string[] = []
      const outcome = yield* attempt(() => QueryText.with(call.collect ? texts : null, body))
      const text = call.text ?? (texts.length > 0 ? texts.join('; ') : undefined)

      handle.setAttribute('db.query.text', text)

      if (isFailure(outcome)) {
        handle.setAttribute('db.response.status_code', statusCodeOf(outcome))

        return yield* outcome
      }

      if (call.rows) {
        handle.setAttribute('db.response.returned_rows', call.rows(outcome.value))
      }

      return outcome.value
    },
  )
}

/** Change-log tables (`__changes_<table>`) are the core's own bookkeeping: never traced. */
const isLogTable = (table: Spec.Table): boolean => table.name.startsWith(CHANGES_PREFIX)

/**
 * The ONE place db spans come from: the data plane of `adapter` (find / count / aggregate /
 * insert / update / remove / transaction / raw) wrapped in child-only db CLIENT spans — INTERNAL
 * for the in-process memory adapter — carrying the backend's identity (`adapterIdentity`).
 * Introspection and migration pass through untraced, and so does every change-log table.
 */
export const traced = (
  adapter: Adapter.Actions,
  info: Adapter.Options,
  observe?: Database.ObserveOptions,
): Adapter.Actions => {
  const identity = adapterIdentity(info)
  const counted = observe?.returnedRows === true
  const rows = counted ? (docs: readonly Spec.Doc[]) => docs.length : undefined

  return {
    find: spec =>
      isLogTable(spec.table)
        ? adapter.find(spec)
        : dbSpan(identity, { op: 'find', table: spec.table.name, collect: true, rows }, () =>
            adapter.find(spec),
          ),

    count: spec =>
      isLogTable(spec.table)
        ? adapter.count(spec)
        : dbSpan(identity, { op: 'count', table: spec.table.name, collect: true }, () =>
            adapter.count(spec),
          ),

    aggregate: spec =>
      isLogTable(spec.table)
        ? adapter.aggregate(spec)
        : dbSpan(identity, { op: 'aggregate', table: spec.table.name, collect: true, rows }, () =>
            adapter.aggregate(spec),
          ),

    insert: (table, docs) =>
      isLogTable(table)
        ? adapter.insert(table, docs)
        : dbSpan(
            identity,
            { op: 'insert', table: table.name, batch: docs.length, collect: true, rows },
            () => adapter.insert(table, docs),
          ),

    update: spec =>
      isLogTable(spec.table)
        ? adapter.update(spec)
        : dbSpan(identity, { op: 'update', table: spec.table.name, collect: true, rows }, () =>
            adapter.update(spec),
          ),

    remove: spec =>
      isLogTable(spec.table)
        ? adapter.remove(spec)
        : dbSpan(identity, { op: 'delete', table: spec.table.name, collect: true, rows }, () =>
            adapter.remove(spec),
          ),

    transaction: <T>(body: () => Operation<T>) =>
      dbSpan<T>(identity, { op: 'transaction', collect: false }, () => adapter.transaction(body)),

    raw: (statement, params, table) =>
      dbSpan(
        identity,
        {
          // named `raw` only: the decode table need not be what the statement targets
          op: 'raw',
          // only a statement whose values are bound is recorded (a bare one may inline them)
          text: params && params.length > 0 ? statement : undefined,
          collect: false,
          rows: counted ? (result: Adapter.RawResult) => result.rows.length : undefined,
        },
        () => adapter.raw(statement, params, table),
      ),

    introspect: table => adapter.introspect(table),
    tables: () => adapter.tables(),
    migrate: steps => adapter.migrate(steps),
  }
}

/** A transaction retried after a `db.conflict`: an `db.tx.retry` event on the caller's span
 * (`attempt` = the attempt about to run, 2 for the first retry). */
export function* txRetry(attemptNumber: number): Operation<void> {
  const handle = yield* Trace.actions.current()

  handle.addEvent(TX_RETRY_EVENT, { 'ozaco.db.transaction.attempt': attemptNumber })
}

/** A store's identity: its own `telemetry`, else the store name (`memory` ⇒ `ozaco.memory`) and
 * its prefix. */
const kvIdentity = (info: KvDef.Options): Helpers.DbIdentity & { readonly collection: string } => {
  const telemetry = info.telemetry ?? {
    system: info.store === 'memory' ? MEMORY_SYSTEM : info.store,
    namespace: info.store,
    collection: info.prefix,
  }

  return {
    ...telemetry,
    kind: telemetry.system === MEMORY_SYSTEM ? 'internal' : 'client',
  }
}

/**
 * Run one Kv op of the dispatched store in its `{op} kv` span — child-only, CLIENT (INTERNAL for
 * an in-process store) — with the backing store's identity and `db.collection.name` = the prefix
 * or the backing table. The adapter calls the op makes (a `TableKv`) open no db spans.
 */
export function* kvSpan<T>(op: string, body: () => Operation<T>, batch?: number): Operation<T> {
  const identity = kvIdentity(yield* Kv.context.expect())

  return yield* Trace.actions.span(
    `${op} kv`,
    {
      kind: identity.kind,
      scope: TELEMETRY_SCOPE,
      requireParent: true,
      attributes: {
        ...identityAttributes(identity),
        'db.collection.name': identity.collection,
        'db.operation.name': op,
        'db.operation.batch.size': batch !== undefined && batch > 1 ? batch : undefined,
      },
      failure: { eventName: DB_EXCEPTION_EVENT },
    },
    () => InKv.with(true, body),
  )
}
