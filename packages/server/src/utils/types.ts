import type { Flow, Operation } from 'std:effect'

/**
 * A pipeable {@link Flow} transformation: takes a source flow, returns a derived flow. The close
 * value type always passes through untouched — operators transform items, never the close.
 */
export type FlowOperator<T, R, TClose = unknown> = (source: Flow<T, TClose>) => Flow<R, TClose>

/** The overloaded call surface of `pipeFlow` — left-to-right operator application. */
export interface PipeFlow {
  <T, TClose>(source: Flow<T, TClose>): Flow<T, TClose>
  <T, A, TClose>(source: Flow<T, TClose>, operatorA: FlowOperator<T, A, TClose>): Flow<A, TClose>
  <T, A, B, TClose>(
    source: Flow<T, TClose>,
    operatorA: FlowOperator<T, A, TClose>,
    operatorB: FlowOperator<A, B, TClose>,
  ): Flow<B, TClose>
  <T, A, B, C, TClose>(
    source: Flow<T, TClose>,
    operatorA: FlowOperator<T, A, TClose>,
    operatorB: FlowOperator<A, B, TClose>,
    operatorC: FlowOperator<B, C, TClose>,
  ): Flow<C, TClose>
  <T, A, B, C, D, TClose>(
    source: Flow<T, TClose>,
    operatorA: FlowOperator<T, A, TClose>,
    operatorB: FlowOperator<A, B, TClose>,
    operatorC: FlowOperator<B, C, TClose>,
    operatorD: FlowOperator<C, D, TClose>,
  ): Flow<D, TClose>
  <T, A, B, C, D, E, TClose>(
    source: Flow<T, TClose>,
    operatorA: FlowOperator<T, A, TClose>,
    operatorB: FlowOperator<A, B, TClose>,
    operatorC: FlowOperator<B, C, TClose>,
    operatorD: FlowOperator<C, D, TClose>,
    operatorE: FlowOperator<D, E, TClose>,
  ): Flow<E, TClose>
}

/** Options for `batchFlow`. */
export interface BatchOptions {
  /** Emit a batch as soon as this many items are buffered. */
  size: number
  /**
   * Also emit once this many milliseconds have elapsed since the FIRST buffered item, even if the
   * batch is not full yet. Omit to only ever emit on `size` (plus the final flush before close).
   */
  maxWaitMs?: number
}

/** Options for `createTokenBucket`. */
export interface TokenBucketOptions {
  /** Maximum number of tokens the bucket can hold; the bucket starts full. */
  capacity: number
  /** Continuous refill rate in tokens per second (0 disables refill). */
  refillPerSecond: number
  /** Injectable millisecond clock for deterministic tests (default `Date.now`). */
  now?: () => number
}

/** A lazily-refilled token bucket rate limiter. */
export interface TokenBucket {
  /** Take `count` tokens (default 1); `false` when not enough tokens are available. */
  take(count?: number): boolean
  /** Tokens currently available (fractional — refill is continuous). */
  available(): number
}

/** Deduplicates concurrent executions of the same keyed operation. */
export interface Singleflight<T = unknown> {
  /**
   * Run `op` under `key`. The first caller executes; concurrent callers with the same key join and
   * share the SAME outcome — failures re-raise in every joiner. The entry is removed once settled.
   */
  run(key: string, op: () => Operation<T>): Operation<T>
  /** Number of keys currently in flight. */
  size(): number
}

/** Options for `createLease`. */
export interface LeaseOptions {
  /** Time-to-live: how long a renewal keeps the lease alive, in milliseconds. */
  ttlMs: number
  /** Injectable millisecond clock for deterministic tests (default `Date.now`). */
  now?: () => number
}

/** A deterministic keepalive lease: renew before `ttlMs` elapses or it expires. */
export interface Lease {
  /** The time-to-live this lease was created with, in milliseconds. */
  readonly ttlMs: number
  /** Push the expiry deadline to `now() + ttlMs`. */
  renew(): void
  /** Whether the deadline has passed. */
  expired(): boolean
  /** Milliseconds until expiry (0 when already expired). */
  remaining(): number
}

/** One bound log method: a message plus optional structured data. */
export type BoundLogMethod = (msg: string, data?: Record<string, unknown>) => Operation<void>

/**
 * A per-instance logger with pinned bindings. When no `Logger` impl is installed it degrades to a
 * silent no-op, so protocol impls can log unconditionally.
 */
export interface BoundLogger {
  /** The bindings attached to every entry this logger emits. */
  readonly bindings: Record<string, unknown>
  trace: BoundLogMethod
  debug: BoundLogMethod
  info: BoundLogMethod
  warn: BoundLogMethod
  error: BoundLogMethod
  fatal: BoundLogMethod
  /** Derive a logger with `extra` merged on top of the current bindings. */
  child(extra: Record<string, unknown>): BoundLogger
}
