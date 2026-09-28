import type { Database } from 'db:core'
import { DbClient, DbErrors, where } from 'db:core'
import { TELEMETRY_SCOPE } from 'db:internal'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { IO } from 'std:io'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import pkg from '../../package.json'

import { QueueErrors } from './errors'
import {
  FINISHED,
  MESSAGING_SYSTEM,
  QUEUE_COLUMNS,
  SEND_EXCEPTION_EVENT,
  TRACE_COLUMNS,
} from './internal/const'
import { settingsOf, startWorker } from './internal/worker'
import type { QueueDef } from './types/queue'

/** The installed `DbClient`'s handle, or `db:queue.configuration`. */
function* handleOf() {
  const db = yield* attempt(() => DbClient.context.expect())

  if (isFailure(db)) {
    return yield* fail(
      QueueErrors.Configuration,
      'the queue needs a database — install DbClient (with the queue table) before Queue',
      db,
    )
  }

  return db.value as AnyType as Database.Handle
}

/** Insert the job — or, with a dedupe key, keep ONE live job per key: re-arm only a finished one,
 * atomic on every adapter (a concurrent enqueue of the same key loses to the unique index and
 * retries as the update it now is). */
// oxlint-disable-next-line max-params
function* store(
  db: AnyType,
  table: string,
  value: Record<string, unknown>,
  dedupeKey: string | undefined,
): Operation<QueueDef.Enqueued<AnyType>> {
  if (dedupeKey === undefined) {
    return { op: 'inserted', job: yield* db.insert(table, value) }
  }

  const outcome = yield* db.upsert(table, { dedupe_key: dedupeKey }, value, {
    when: where.oneOf('state', FINISHED),
  })

  return { op: outcome.op, job: outcome.doc }
}

/** Whether a DECLARED table misses some of `columns` (`db.validation` from the projection check;
 * any other failure — storage not migrated yet — says nothing about the declaration). */
function* lacks(db: AnyType, table: string, columns: readonly string[]) {
  const probe = yield* attempt(
    db
      .query(table)
      .select(...columns)
      .take(0),
  )

  return isFailure(probe) && probe.error === DbErrors.Validation ? probe : null
}

/** An optional name: absent, or a non-empty string. */
const isName = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && value.length > 0)

const QueueImpl = definePlugin<QueueDef.Context, [options: QueueDef.Options]>({
  name: 'db-queue',
  version: pkg.version,
  description: 'Durable job queue over the installed database',

  *setup(options) {
    if (typeof options?.table !== 'string' || options.table.length === 0) {
      return yield* fail(QueueErrors.Configuration, 'Queue.use needs the queue `table` name')
    }

    if (!isName(options.service)) {
      return yield* fail(
        QueueErrors.Configuration,
        'the queue `service` must be a non-empty string',
      )
    }

    const db = (yield* handleOf()) as AnyType
    // the columns are checked against the DECLARED table before anything touches storage
    const missing = yield* lacks(db, options.table, QUEUE_COLUMNS)

    if (missing) {
      return yield* fail(
        QueueErrors.Configuration,
        `"${options.table}" is not a queue table of the installed DbClient — declare it with queueTable("${options.table}")`,
        missing,
      )
    }

    // a table declared by an older `queueTable` has no trace columns: it runs untraced
    const traced = (yield* lacks(db, options.table, TRACE_COLUMNS)) === null

    return { table: options.table, service: options.service ?? options.table, traced }
  },
})

const isCount = (value: unknown, min: number): boolean =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= min)

/**
 * A durable job queue in a table of the installed database — `Queue.use({ table })` after
 * `DbClient` (whose schema declares `queueTable(table)`), then `Queue.actions.enqueue(…)` and
 * `Queue.actions.work(handlers, …)`. Jobs survive restarts (they are rows), retry with backoff,
 * dead-letter after `maxAttempts`, deduplicate by key (re-armed only once finished), and a
 * crashed worker's jobs come back when their lease lapses. Workers wake on the table's change
 * feed (and the bus, across nodes) and poll at most `pollMs` apart otherwise; they halt with the
 * scope that started them.
 *
 * Traced (`std:trace`): an enqueue is a PRODUCER span `send {table}` whose context the row keeps;
 * every attempt is a ROOT CONSUMER span `process {table}` LINKING that context (`creation`) and the
 * previous attempt's (`queue.retry`) — find a job's attempts by `messaging.message.id`. Attempts
 * run as the queue's `service` (`Queue.use({ service })` / `work(…, { service })`, default the
 * table name), so their `service.name` is the worker's, not the node's default. A failure
 * with attempts left is recorded WARN, a dead letter ERROR with the span event `queue.dead`;
 * the claim loop and the sweeper open no spans.
 */
export const Queue = QueueImpl.build<QueueDef.Actions>({
  *enqueue(kind: string, payload?: unknown, options?: QueueDef.EnqueueOptions) {
    const { table, traced } = yield* QueueImpl.context.expect()
    const db = (yield* handleOf()) as AnyType

    if (typeof kind !== 'string' || kind.length === 0) {
      return yield* fail(QueueErrors.Validation, 'a job needs a non-empty kind')
    }

    if (!isCount(options?.priority, Number.MIN_SAFE_INTEGER) || !isCount(options?.maxAttempts, 1)) {
      return yield* fail(
        QueueErrors.Validation,
        '`priority` must be an integer and `maxAttempts` an integer >= 1',
      )
    }

    const runAt =
      options?.runAt instanceof Date ? options.runAt.getTime() : (options?.runAt ?? Date.now())

    if (!Number.isFinite(runAt)) {
      return yield* fail(QueueErrors.Validation, '`runAt` must be a valid Date or epoch ms')
    }

    const dedupeKey = options?.dedupeKey

    // the PRODUCER span: its context rides the row, so every attempt of the job links it
    return yield* Trace.actions.span(
      `send ${table}`,
      {
        kind: 'producer',
        scope: TELEMETRY_SCOPE,
        attributes: {
          'messaging.system': MESSAGING_SYSTEM,
          'messaging.operation.type': 'send',
          'messaging.operation.name': 'enqueue',
          'messaging.destination.name': table,
          'ozaco.queue.kind': kind,
        },
        failure: { eventName: SEND_EXCEPTION_EVENT },
      },
      function* (handle) {
        const context: TraceDef.Carrier = traced ? yield* Trace.actions.inject() : {}

        const value = {
          kind,
          payload: payload ?? null,
          state: 'queued',
          priority: options?.priority ?? 0,
          run_at: Math.trunc(runAt),
          attempts: 0,
          max_attempts: options?.maxAttempts ?? null,
          lease_until: null,
          worker: null,
          last_error: null,
          finished_at: null,
          ...(traced
            ? {
                traceparent: context.traceparent ?? null,
                tracestate: context.tracestate ?? null,
                last_traceparent: null,
              }
            : {}),
        }

        const enqueued = yield* store(db, table, value, dedupeKey)

        handle.setAttributes({
          'messaging.message.id': enqueued.job._id,
          'ozaco.queue.op': enqueued.op,
        })

        return enqueued
      },
    )
  },

  *work(handlers: QueueDef.Handlers, options?: QueueDef.WorkOptions) {
    const { table, traced, service } = yield* QueueImpl.context.expect()
    const db = yield* handleOf()

    if (
      typeof handlers !== 'object' ||
      handlers === null ||
      Object.keys(handlers).length === 0 ||
      Object.values(handlers).some(handler => typeof handler !== 'function')
    ) {
      return yield* fail(QueueErrors.Validation, '`work` needs at least one handler function')
    }

    if (!isName(options?.service)) {
      return yield* fail(QueueErrors.Validation, 'work option "service" must be a non-empty string')
    }

    const settings = yield* settingsOf(options)
    const id = yield* IO.actions.ulid({ length: 32, window: 100 })

    return yield* startWorker(
      { db, table, id, handlers, traced, service: options?.service ?? service },
      settings,
    )
  },

  *get(id: string) {
    const { table } = yield* QueueImpl.context.expect()
    const db = (yield* handleOf()) as AnyType

    return yield* db.get(table, id)
  },

  *retry(id: string) {
    const { table } = yield* QueueImpl.context.expect()
    const db = (yield* handleOf()) as AnyType

    const revived = yield* db.patch(
      table,
      id,
      {
        state: 'queued',
        attempts: 0,
        run_at: Date.now(),
        lease_until: null,
        worker: null,
        finished_at: null,
      },
      { scope: where.oneOf('state', ['dead', 'failed']) },
    )

    return revived !== null
  },

  *counts() {
    const { table } = yield* QueueImpl.context.expect()
    const db = (yield* handleOf()) as AnyType
    const rows = (yield* db.query(table).groupBy('state').count()) as readonly {
      readonly state: QueueDef.State
      readonly count: number
    }[]
    const counts = { queued: 0, running: 0, done: 0, failed: 0, dead: 0 }

    for (const row of rows) {
      counts[row.state] = Number(row.count)
    }

    return counts
  },
})
