import type { Result } from 'std:result'

import type { Operation, Flow, Subscription } from './operation'

export namespace Utils {
  export interface Exit {
    status: number
    message?: string | undefined
    signal?: string | undefined
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

  export interface EachLoop<T> {
    subscription: Subscription<T, unknown>
    current: IteratorResult<T>
    finish: () => void
    stale?: true
  }

  export interface HostOperation<T> {
    deno(): Operation<T>
    node(): Operation<T>
    browser(): Operation<T>
  }

  /** Options shared by `backoffDelay`, `backoff` and `retry`. */
  export interface BackoffOptions {
    /** Delay of the first attempt in milliseconds (default 250). */
    delayMs?: number
    /** Exponential growth factor applied per attempt (default 2). */
    factor?: number
    /** Upper bound on the computed delay in milliseconds (default 30_000). */
    maxDelayMs?: number
    /**
     * Jitter as a 0..1 fraction of the computed delay that may be randomly shaved off (default 0 —
     * fully deterministic).
     */
    jitter?: number
    /** Injectable randomness source returning 0..1; only consulted when `jitter > 0` (default `Math.random`). */
    random?: () => number
  }

  /** Options for `retry`. */
  export interface RetryOptions extends BackoffOptions {
    /** Maximum number of tries, including the first one (default 3). */
    attempts?: number
    /** Retry predicate: return `false` to re-raise the failure immediately instead of retrying. */
    when?: (failure: Result.Failure<unknown>) => boolean
  }
}
