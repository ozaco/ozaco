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

  /** A counting semaphore (`createSemaphore`): FIFO permits, released on return, failure or halt. */
  export interface Semaphore {
    /** Take a permit (parking FIFO while none is free), run `op` inline, release the permit. */
    run<T>(op: () => Operation<T>): Operation<T>
    /** Permits free right now. */
    available(): number
    /** Callers parked for a permit right now. */
    waiting(): number
  }

  /** A single-permit semaphore (`createMutex`). */
  export interface Mutex {
    run<T>(op: () => Operation<T>): Operation<T>
    /** Whether a `run` body currently holds the lock. */
    locked(): boolean
    waiting(): number
  }

  export type BreakerState = 'closed' | 'open' | 'half-open'

  /** Options for `createBreaker`. */
  export interface BreakerOptions {
    /** Consecutive (counted) failures that trip the circuit open. */
    failures: number
    /** How long an open circuit fails fast before letting one trial through (default 10_000). */
    halfOpenMs?: number | undefined
    /** Which failures count towards tripping (default: all). An ignored failure is re-raised as is. */
    when?: ((failure: Result.Failure<unknown>) => boolean) | undefined
    /** Prefix of the `BreakerOpen` message (`<name>: circuit open`). */
    name?: string | undefined
    /** Clock in ms (default `Date.now`) — injectable for tests. */
    now?: (() => number) | undefined
  }

  /** A circuit breaker (`createBreaker`). */
  export interface Breaker {
    /** Run `op` through the circuit: fails fast with `EffectErrors.BreakerOpen` while open. */
    run<T>(op: () => Operation<T>): Operation<T>
    /** Open the circuit by hand; a `terminal` trip never half-opens — only `reset()` closes it. */
    trip(reason?: unknown, options?: { terminal?: boolean | undefined }): void
    /** Close the circuit and forget the failure count and the reason. */
    reset(): void
    state(): BreakerState
    /** What opened the circuit: the tripping Failure or the `trip` reason (`undefined` when closed). */
    readonly reason: unknown
    /** Consecutive counted failures so far. */
    readonly failures: number
  }

  /** Options for `retry`. */
  export interface RetryOptions extends BackoffOptions {
    /** Maximum number of tries, including the first one (default 3). */
    attempts?: number | undefined
    /** Retry predicate: return `false` to re-raise the failure immediately instead of retrying. */
    when?: ((failure: Result.Failure<unknown>) => boolean) | undefined
  }
}
