import type { Result } from 'std:result'

import type { Operation, Flow } from './operation'

export namespace Utils {
  /** How `main` ends: the process status (130 = SIGINT, 143 = SIGTERM), an optional message
   * (stdout on 0, stderr otherwise) and the error that ended it, if any. */
  export interface Exit {
    status: number
    message?: string | undefined
    error?: unknown | undefined
  }

  export type Yielded<T extends Operation<unknown>> =
    T extends Operation<infer TYield> ? TYield : never

  export type All<T extends readonly Operation<unknown>[] | []> = {
    -readonly [P in keyof T]: Yielded<T[P]>
  }

  export type AllSettled<T extends readonly Operation<unknown>[] | []> = {
    -readonly [P in keyof T]: Result<Yielded<T[P]>>
  }

  export interface Each {
    <T>(flow: Flow<T, unknown>): Operation<Iterable<T>>
    next(): Operation<void>
  }

  export interface HostOperation<T> {
    deno(): Operation<T>
    node(): Operation<T>
    browser(): Operation<T>
  }

  /** Options shared by `backoffDelay`, `backoff` and `retry`. */
  export interface BackoffOptions {
    /** Delay of the first attempt in milliseconds (default 250). */
    delayMs?: number | undefined
    /** Exponential growth factor applied per attempt (default 2). */
    factor?: number | undefined
    /** Upper bound on the computed delay in milliseconds (default 30_000). */
    maxDelayMs?: number | undefined
    /**
     * Jitter as a 0..1 fraction of the computed delay that may be randomly shaved off (default 0 —
     * fully deterministic).
     */
    jitter?: number | undefined
    /** Injectable randomness source returning 0..1; only consulted when `jitter > 0` (default `Math.random`). */
    random?: (() => number) | undefined
  }

  /** A resolved retry budget (see `budgetOf`): attempt `n` waits `delayMs * backoff^n`, capped. */
  export interface Budget {
    retries: number
    delayMs: number
    backoff: number
    maxDelayMs: number
  }

  /** What a consumer writes for a budget — every field optional, filled from `BUDGET_DEFAULTS`. */
  export interface BudgetOptions {
    /** Max attempts per outage (default `5`). */
    retries?: number | undefined
    /** Delay before the first attempt, in ms (default `250`). */
    delayMs?: number | undefined
    /** Exponential multiplier per attempt: attempt `n` waits `delayMs * backoff^n` (default `1`). */
    backoff?: number | undefined
    /** Upper bound for the computed delay in ms (default `30_000`). */
    maxDelayMs?: number | undefined
  }

  /** A re-armed wait point: `wait()` parks until the next `notify()`, which also arms a fresh gate. */
  export interface Gate {
    wait(): Operation<void>
    notify(): void
  }

  /** Options for `retry`. */
  export interface RetryOptions extends BackoffOptions {
    /** Maximum number of tries, including the first one (default 3). */
    attempts?: number | undefined
    /** Retry predicate: return `false` to re-raise the failure immediately instead of retrying. */
    when?: ((failure: Result.Failure<unknown>) => boolean) | undefined
  }
}
