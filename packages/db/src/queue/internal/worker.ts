// oxlint-disable import/exports-last
import type { Database } from 'db:core'
import { where } from 'db:core'
import type { Operation, Task } from 'std:effect'
import { all, attempt, fork, race, sleep } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { QueueErrors } from '../errors'
import type { QueueDef } from '../types'

import {
  CLAIMABLE,
  DEFAULT_BACKOFF,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_POLL_MS,
  ERROR_LIMIT,
  SWEEP_BATCH,
} from './const'

type Row = QueueDef.Row<AnyType>

interface Settings {
  readonly batch: number
  readonly backoff: QueueDef.Backoff
  readonly maxAttempts: number
  readonly pollMs: number
  readonly leaseMs: number
  readonly sweepMs: number
}

const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min

/** Resolve + check the worker options (`db:queue.validation` on nonsense). */
export function* settingsOf(options: QueueDef.WorkOptions | undefined) {
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS

  const settings: Settings = {
    batch: options?.batch ?? 1,
    backoff: options?.backoff ?? DEFAULT_BACKOFF,
    maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    pollMs: options?.pollMs ?? DEFAULT_POLL_MS,
    leaseMs,
    sweepMs: options?.sweepMs ?? Math.max(1, Math.trunc(leaseMs / 2)),
  }

  const bad = (
    [
      ['batch', settings.batch, 1],
      ['maxAttempts', settings.maxAttempts, 1],
      ['pollMs', settings.pollMs, 1],
      ['leaseMs', settings.leaseMs, 3],
      ['sweepMs', settings.sweepMs, 1],
    ] as const
  ).find(([, value, min]) => !isCount(value, min))

  if (bad) {
    return yield* fail(
      QueueErrors.Validation,
      `work option "${bad[0]}" must be an integer >= ${bad[2]}`,
    )
  }

  return settings
}

/** The retry delay after attempt number `failed` (1-based) failed. */
export const delayOf = (backoff: QueueDef.Backoff, failed: number): number => {
  if (typeof backoff === 'function') {
    return Math.max(0, Math.trunc(backoff(failed)) || 0)
  }

  const cap = backoff.maxMs ?? Number.POSITIVE_INFINITY

  const raw =
    backoff.kind === 'linear'
      ? (backoff.stepMs ?? 1000) * failed
      : (backoff.baseMs ?? 1000) * 2 ** Math.max(0, failed - 1)

  return Math.max(0, Math.min(cap, raw))
}

const describe = (failure: { readonly error: unknown; readonly message: string }): string =>
  `${String(failure.error)}: ${failure.message}`.slice(0, ERROR_LIMIT)

/** What a failed attempt turns the job into: another try later, or the dead letter. */
// oxlint-disable-next-line max-params
const failedPatch = (row: Row, settings: Settings, reason: string, now: number) =>
  row.attempts >= (row.max_attempts ?? settings.maxAttempts)
    ? {
        state: 'dead',
        lease_until: null,
        worker: null,
        last_error: reason,
        finished_at: now,
      }
    : {
        state: 'failed',
        run_at: now + delayOf(settings.backoff, row.attempts),
        lease_until: null,
        worker: null,
        last_error: reason,
      }

/**
 * Start a worker: a claim loop woken by the table's change feed (and at most `pollMs` apart),
 * plus a lease sweeper, both forked into the CURRENT scope. Claims are single guarded UPDATEs
 * (`_version` + a claimable state), so any number of workers — in any number of processes —
 * never run the same attempt twice; a running job renews its lease, and every write that
 * settles it is guarded by (worker, attempt), so a worker that lost its lease cannot overwrite
 * the job's newer state.
 */
export function* startWorker(
  input: {
    readonly db: Database.Handle
    readonly table: string
    readonly id: string
    readonly handlers: QueueDef.Handlers
  },
  settings: Settings,
) {
  const { table, id, handlers } = input
  const db = input.db as AnyType
  const kinds = Object.keys(handlers)
  const stats = { claimed: 0, done: 0, retried: 0, dead: 0, swept: 0, errors: 0 }

  /** Run one claimed job to its next state. Halted mid-run, it hands the job back. */
  const run = function* (row: Row) {
    // every write that settles THIS attempt: the job is still ours, at this attempt
    const ours = where.and(
      where.eq('state', 'running'),
      where.eq('worker', id),
      where.eq('attempts', row.attempts),
    )
    let settled = false

    const heartbeat = function* (): Operation<never> {
      for (;;) {
        yield* sleep(Math.max(1, Math.trunc(settings.leaseMs / 3)))
        yield* attempt(
          db.patch(table, row._id, { lease_until: Date.now() + settings.leaseMs }, { scope: ours }),
        )
      }
    }

    try {
      const job: QueueDef.Job = {
        id: row._id,
        kind: row.kind,
        payload: row.payload,
        attempt: row.attempts,
        maxAttempts: row.max_attempts ?? settings.maxAttempts,
        dedupeKey: row.dedupe_key,
        row,
      }

      const outcome = (yield* race([
        attempt(() => handlers[row.kind]!(job)),
        heartbeat(),
      ])) as Awaited<ReturnType<typeof attempt>>
      const now = Date.now()

      if (isFailure(outcome)) {
        const next = failedPatch(row, settings, describe(outcome), now)
        yield* db.patch(table, row._id, next, { scope: ours })

        if (next.state === 'dead') {
          stats.dead += 1
        } else {
          stats.retried += 1
        }
      } else {
        yield* db.patch(
          table,
          row._id,
          { state: 'done', lease_until: null, last_error: null, finished_at: now },
          { scope: ours },
        )
        stats.done += 1
      }

      settled = true
    } finally {
      if (!settled) {
        // halted (or the settle write failed): hand the job back, this attempt uncounted
        yield* attempt(
          db.patch(
            table,
            row._id,
            { state: 'queued', attempts: row.attempts - 1, lease_until: null, worker: null },
            { scope: ours },
          ),
        )
      }
    }
  }

  /** Claim up to `batch` due jobs and run them concurrently; answers how many were claimed. */
  const round = function* () {
    const now = Date.now()
    const ready = (yield* db
      .query(table)
      .filter(where.oneOf('state', CLAIMABLE), where.lte('run_at', now), where.oneOf('kind', kinds))
      .order('priority', 'desc')
      .order('run_at')
      .take(settings.batch)) as readonly Row[]
    const claimed: Row[] = []

    for (const row of ready) {
      const next = (yield* db.patch(
        table,
        row._id,
        {
          state: 'running',
          attempts: row.attempts + 1,
          lease_until: now + settings.leaseMs,
          worker: id,
        },
        // lost the race to another worker → the guarded UPDATE misses (null), no conflict
        { scope: where.and(where.eq('_version', row._version), where.oneOf('state', CLAIMABLE)) },
      )) as Row | null

      if (next) {
        claimed.push(next)
      }
    }

    stats.claimed += claimed.length

    if (claimed.length > 0) {
      yield* all(claimed.map(row => attempt(() => run(row))))
    }

    return claimed.length
  }

  /** How long to sleep before the next claim: until the next job is due, at most `pollMs`. */
  const pause = function* () {
    const next = (yield* db
      .query(table)
      .filter(where.oneOf('state', CLAIMABLE), where.oneOf('kind', kinds))
      .order('run_at')
      .first()) as Row | null

    return next === null
      ? settings.pollMs
      : Math.max(0, Math.min(settings.pollMs, next.run_at - Date.now()))
  }

  /** Put lapsed leases (a worker died mid-job) back in line — or dead-letter them. */
  const sweep = function* () {
    const now = Date.now()
    const lapsed = (yield* db
      .query(table)
      .filter(where.eq('state', 'running'), where.lt('lease_until', now))
      .take(SWEEP_BATCH)) as readonly Row[]

    for (const row of lapsed) {
      const next = yield* db.patch(
        table,
        row._id,
        failedPatch(row, settings, 'lease expired', now),
        {
          scope: where.and(where.eq('_version', row._version), where.eq('state', 'running')),
        },
      )

      if (next) {
        stats.swept += 1
      }
    }
  }

  const task: Task<void> = yield* fork(function* () {
    yield* fork(function* () {
      for (;;) {
        if (isFailure(yield* attempt(sweep))) {
          stats.errors += 1
        }

        yield* sleep(settings.sweepMs)
      }
    })

    // local writes (and bus-delivered ones) wake the loop at once; `pollMs` bounds the rest
    const changes = yield* db.changes(table)

    for (;;) {
      const claimed = yield* attempt(round)

      if (isFailure(claimed)) {
        stats.errors += 1
      } else if (claimed.value > 0) {
        continue
      }

      const delay = yield* attempt(pause)
      const wait = isFailure(delay) ? settings.pollMs : delay.value

      // at least a tick: a due job someone else just took must not spin this loop hot
      yield* race([changes.next(), sleep(Math.max(1, wait))])
    }
  })

  return {
    id,
    stats: () => ({ ...stats }),
    halt: () => task.halt(),
  } as QueueDef.Worker
}
