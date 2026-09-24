import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

/**
 * The durable job queue over `@ozaco/db`: the job row, the enqueue/work surface and the install
 * options.
 */
export namespace QueueDef {
  /**
   * A job's lifecycle:
   *
   *   queued ──claim──▶ running ──ok──▶ done
   *     ▲                  │
   *     │   (due again)    ├──error, attempts left──▶ failed ──(run_at due)──▶ running …
   *     └──── re-arm ──────┤
   *        (dedupe, only   └──error, out of attempts──▶ dead
   *        done/dead)
   *
   * A `running` job whose worker's lease expired (the process died) is swept back to `failed`
   * (or `dead` when it has no attempts left).
   */
  export type State = 'queued' | 'running' | 'done' | 'failed' | 'dead'

  /** A job row as stored (the columns `queueTable` declares plus the system fields). */
  export interface Row<TPayload = unknown> {
    readonly _id: string
    readonly _created_at: number
    readonly _updated_at: number
    readonly _version: string
    readonly kind: string
    readonly payload: TPayload | null
    readonly state: State
    readonly dedupe_key: string | null
    readonly priority: number

    /** epoch ms the job is due at (claimable once `run_at <= now`). */
    readonly run_at: number
    readonly attempts: number
    readonly max_attempts: number | null
    readonly lease_until: number | null
    readonly worker: string | null
    readonly last_error: string | null
    readonly finished_at: number | null
  }

  /** What a handler receives. */
  export interface Job<TPayload = unknown> {
    readonly id: string
    readonly kind: string
    readonly payload: TPayload

    /** this run's attempt number (1-based). */
    readonly attempt: number
    readonly maxAttempts: number
    readonly dedupeKey: string | null
    readonly row: Row<TPayload>
  }

  /** A job handler: succeed → `done`; fail (a Result failure or a throw) → retry or dead. */
  export type Handler<TPayload = AnyType> = (job: Job<TPayload>) => Operation<unknown>

  /** Handlers by job kind — a worker only ever claims the kinds it has a handler for. */
  export type Handlers = Readonly<Record<string, Handler>>

  /** Retry spacing: `exponential` (`baseMs · 2^(attempt-1)`), `linear` (`stepMs · attempt`),
   * both capped by `maxMs`, or a function of the attempt number that just failed. */
  export type Backoff =
    | {
        readonly kind: 'exponential'
        readonly baseMs?: number | undefined
        readonly maxMs?: number | undefined
      }
    | {
        readonly kind: 'linear'
        readonly stepMs?: number | undefined
        readonly maxMs?: number | undefined
      }
    | ((attempt: number) => number)

  export interface EnqueueOptions {
    /** One LIVE job per key: while a job with this key is queued/running/failed the enqueue is
     * a no-op (`op: 'skipped'`); once it is `done` or `dead` the enqueue RE-ARMS it (`op:
     * 'updated'` — same row, attempts reset). Atomic on every adapter. */
    readonly dedupeKey?: string | undefined

    /** Not before this time (`Date` or epoch ms). Default now. */
    readonly runAt?: Date | number | undefined

    /** Higher runs first. Default 0. */
    readonly priority?: number | undefined

    /** Overrides the worker's `maxAttempts` for this job. */
    readonly maxAttempts?: number | undefined
  }

  export interface Enqueued<TPayload = unknown> {
    /** `inserted` — a new job; `updated` — a finished job with the same `dedupeKey` was
     * re-armed; `skipped` — a live job with that key already exists (returned as-is). */
    readonly op: 'inserted' | 'updated' | 'skipped'
    readonly job: Row<TPayload>
  }

  export interface WorkOptions {
    /** Jobs claimed and run concurrently per round. Default 1. */
    readonly batch?: number | undefined

    /** Default `{ kind: 'exponential', baseMs: 1000, maxMs: 300_000 }`. */
    readonly backoff?: Backoff | undefined

    /** Attempts before a job is dead-lettered (per-job `maxAttempts` wins). Default 5. */
    readonly maxAttempts?: number | undefined

    /** The longest the worker sleeps between claims when the change feed is quiet (a job
     * enqueued by ANOTHER process without a bus, a `runAt` coming due). Local enqueues wake it
     * at once. Default 1000. */
    readonly pollMs?: number | undefined

    /** How long a claim holds a job; the running worker renews it every `leaseMs / 3`. A job
     * whose lease lapsed (its worker died) is swept back for a retry. Default 30_000. */
    readonly leaseMs?: number | undefined

    /** How often this worker sweeps lapsed leases. Default `leaseMs / 2`. */
    readonly sweepMs?: number | undefined
  }

  export interface WorkerStats {
    readonly claimed: number
    readonly done: number
    readonly retried: number
    readonly dead: number

    /** lapsed leases this worker swept back. */
    readonly swept: number

    /** loop-level failures (the database was unreachable, …) — the loop keeps going. */
    readonly errors: number
  }

  /** A running worker — it lives in the scope `work` was called in and halts with it. */
  export interface Worker {
    readonly id: string
    stats(): WorkerStats

    /** Stop now: in-flight jobs are released back to `queued` (the attempt is not counted). */
    halt(): Operation<void>
  }

  export interface Counts {
    readonly queued: number
    readonly running: number
    readonly done: number
    readonly failed: number
    readonly dead: number
  }

  export interface Options {
    /** The queue table's name — declare it with `queueTable(name)` in the `DbClient` schema. */
    readonly table: string
  }

  export interface Context {
    readonly table: string
  }

  export interface Actions {
    enqueue<TPayload = unknown>(
      kind: string,
      payload?: TPayload,
      options?: EnqueueOptions,
    ): Operation<Enqueued<TPayload>>

    /** Start a worker in the CURRENT scope (it halts with it). */
    work(handlers: Handlers, options?: WorkOptions): Operation<Worker>

    get<TPayload = unknown>(id: string): Operation<Row<TPayload> | null>

    /** Put a `dead` (or `failed`) job back in line now, attempts reset. `false` when the job is
     * not in one of those states. */
    retry(id: string): Operation<boolean>

    /** Job count per state. */
    counts(): Operation<Counts>
  }

  export type Queue = Plugin<Context, [options: Options], Actions>
}
