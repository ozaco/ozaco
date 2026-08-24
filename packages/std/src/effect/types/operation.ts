import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { CONTEXT } from '../const'

import type { Helpers } from './helpers'

export interface Operation<T> {
  [Symbol.iterator](): Iterator<Helpers.Effect<unknown> | Result.Failure<AnyType>, T, unknown>
}

export type ManualOperation<T> = Generator<
  Helpers.Effect<unknown> | Result.Failure<AnyType>,
  T,
  unknown
>

/**
 * An {@link Operation} that is also awaitable. The promise side resolves to a `Result` and never
 * rejects (std contract) — success resolves `Success<T>`, an operation failure resolves the
 * `Failure` itself, and a halt resolves `fail('halted')`. The operation side (`yield*`) returns
 * the value or raises the Failure.
 */
export interface Future<T> extends Operation<T>, Promise<Result<T>> {}

export interface Task<T> extends Future<T> {
  halt(): Future<void>

  [Symbol.asyncDispose](): Promise<void>
}

export interface Context<T> {
  _t: typeof CONTEXT
  name: string
  defaultValue?: T | undefined
  get(): Operation<T | undefined>
  set(value: T): Operation<T>
  expect(): Operation<T>
  delete(): Operation<boolean>
  with<R>(value: T, operation: (value: T) => Operation<R>): Operation<R>
}

export interface Scope {
  /**
   * Run an operation as a task of this scope and return its handle. By default the task is
   * SUPERVISED: a failure also crashes this scope (structured concurrency — same as `spawn`).
   * Pass `{ detached: true }` for delivery-only semantics: the failure settles the task's future
   * and goes no further (edge bridges, dispatch fan-outs, fire-and-forget pumps).
   */
  run<T>(operation: () => Operation<T>, options?: { detached?: boolean | undefined }): Task<T>
  spawn<T>(operation: () => Operation<T>): Operation<Task<T>>
  /** Like `spawn`, but resolves only after the child has run to its first suspension point. */
  fork<T>(operation: () => Operation<T>): Operation<Task<T>>
  get<T>(context: Context<T>): T | undefined
  set<T>(context: Context<T>, value: T): T
  expect<T>(context: Context<T>): T
  delete<T>(context: Context<T>): boolean
  hasOwn<T>(context: Context<T>): boolean
  around<A>(api: Api<A>, ...options: Parameters<Api<A>['around']>): void
}

export interface Subscription<T, TDone> {
  next(): Operation<IteratorResult<T, TDone>>
}

export type Flow<T, TReturn> = Operation<Subscription<T, TReturn>>

/**
 * A {@link Flow} that is ALSO async-iterable — the {@link Future} idea applied to streams, so
 * neither world gives anything up: `yield*` opens it inline (the consuming scope paces and
 * cancels it, plain Flow semantics), while `for await` runs a demand-pulled pump as a detached
 * task of the scope it was created on. `cancel()` halts every open async iteration (a `Future` —
 * `await` or `yield*` it); `done` settles once the async side finished (an iterator completed or
 * failed, or `cancel()` was called) — nothing settles it while the flow is only used as a Flow.
 */
export interface FutureFlow<T> extends Flow<T, void>, AsyncIterable<T> {
  readonly done: Future<void>
  cancel(): Future<void>
}

export interface Signal<T, TClose> extends Flow<T, TClose> {
  send(value: T): void
  close(value: TClose): void
}

export interface Channel<T, TClose> extends Flow<T, TClose> {
  send(message: T): Operation<void>
  close(value: TClose): Operation<void>
}

export interface Queue<T, TClose> extends Subscription<T, TClose> {
  add(item: T): void
  close(value: TClose): void
}

export type Middleware<TArgs extends unknown[], TReturn> = (
  args: TArgs,
  next: (...args: TArgs) => TReturn,
) => TReturn

export type Around<A> = {
  [K in keyof A]: A[K] extends (...args: infer TArgs) => infer TReturn
    ? Middleware<TArgs, TReturn>
    : Middleware<[], A[K]>
}

/**
 * An API whose implementation can be decorated within a scope — the runtime half of the
 * algebraic-effect context system (Effection v4.1 experimental). Create one with `createApi`.
 *
 * Faithful to upstream Effection, with one rename: the member map is `actions` (not `operations`)
 * — `Db.actions.query(...)`.
 */
export interface Api<A> {
  actions: {
    [K in keyof A]: A[K] extends Operation<unknown>
      ? A[K]
      : A[K] extends (...args: infer TArgs) => infer TReturn
        ? TReturn extends Operation<unknown>
          ? A[K]
          : (...args: TArgs) => Operation<TReturn>
        : Operation<A[K]>
  }

  around(
    middlewares: Partial<Around<A>>,
    options?: {
      at: 'min' | 'max'
    },
  ): Operation<void>

  invoke<K extends keyof A>(
    scope: Scope,
    key: K,
    args: A[K] extends (...args: AnyType) => unknown ? Parameters<A[K]> : [],
  ): A[K] extends (...args: AnyType) => unknown ? ReturnType<A[K]> : A[K]
}
