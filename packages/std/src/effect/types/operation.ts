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
 * rejects (std contract); the operation side returns the value or raises the Failure.
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
  run<T>(operation: () => Operation<T>): Task<T>
  spawn<T>(operation: () => Operation<T>): Operation<Task<T>>
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

export type Stream<T, TReturn> = Operation<Subscription<T, TReturn>>

export interface Signal<T, TClose> extends Stream<T, TClose> {
  send(value: T): void
  close(value: TClose): void
}

export interface Channel<T, TClose> extends Stream<T, TClose> {
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
