import type { Result } from 'std:result'

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Defaults to 3. */
  readonly attempts?: number
  /** Delay in milliseconds between retries. Defaults to 0 (no delay). */
  readonly delay?: number
  /** Multiplier applied to delay after each retry. Defaults to 1 (constant delay). */
  readonly backoff?: number
  /** Maximum delay in milliseconds. Defaults to 30_000. */
  readonly maxDelay?: number
  /** Optional predicate — retry only when it returns true. */
  readonly when?: (error: Result.Failure<unknown>) => boolean
}

export interface ConvergeOptions {
  timeout?: number | undefined
  interval?: number | undefined
}

export interface ConvergeStats<T> {
  start: number
  end: number
  elapsed: number
  runs: number
  timeout: number
  interval: number
  value: T
}
