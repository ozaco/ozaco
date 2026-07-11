import type { Maybe, Result } from 'std:result'
import type { AnyFunction, AnyType } from 'std:shared'

import type { Future, Operation, Scope, Subscription } from './operation'

export namespace Helpers {
  export type Yielded<T extends Operation<unknown>> =
    T extends Operation<infer TYield> ? TYield : never

  export interface ErrorBoundary {
    raise(error: unknown): void
  }

  export type CoroutineFuture<T> = Promise<Maybe<Result<T, unknown>>> &
    Operation<Maybe<Result<T, unknown>>>

  export type Settleware = (
    outcome: Maybe<Result<unknown, unknown>>,
    next: (outcome: Maybe<Result<unknown, unknown>>) => void,
  ) => void

  export type Resolve<T> = (value: T) => void

  export type Effect<T> = {
    enter: (
      resolve: Helpers.Resolve<Result<T, unknown>>,
      routine: Coroutine,
    ) => (resolve: Helpers.Resolve<Result<void, unknown>>) => void
    cause: string
  }

  export interface Coroutine<T = unknown> {
    scope: Scope
    future: Helpers.CoroutineFuture<T>
    settle(outcome: Maybe<Result<unknown, unknown>>): void
    data: {
      iterator: Iterator<Effect<unknown> | Result.Failure<unknown>, T, unknown>
      exit(resolve: Helpers.Resolve<Result<unknown, unknown>>): void
      resumeWith: Result<unknown, unknown>
      enqueued: boolean
      critical: boolean
      unwinding: boolean
    }
    // resume the coroutine with `result` once any active effect's exit has run
    resume(result: Result<unknown, unknown>): void
    // begin unwinding (early return) the coroutine — used to halt/cancel
    unwind(): void
    // advance the underlying iterator one step (next / return / throw, per resumeWith + unwinding)
    step(): IteratorResult<Effect<unknown>, T>
    // enter an effect, wiring its single-shot resolve back into resume
    perform(effect: Effect<unknown>): void
  }

  export interface CoroutineOptions<T> {
    scope: Scope
    operation(): Operation<T>
  }

  export interface Exit {
    status: number
    message?: string
    signal?: string
    error?: unknown
  }

  export interface HostOperation<T> {
    deno(): Operation<T>
    node(): Operation<T>
    bun(): Operation<T>
    browser(): Operation<T>
  }

  export interface FutureWithResolvers<T> {
    future: Future<T>
    resolve(value: T): void
    reject(error: unknown): void
  }

  export interface WithResolvers<T> {
    operation: Operation<T>
    resolve(value: T): void
    reject(error: unknown): void
  }

  export type EventTypeFromEventTarget<T, K extends string> = `on${K}` extends keyof T
    ? Parameters<Extract<T[`on${K}`], AnyFunction>>[0]
    : Event

  export type EventList<T> = T extends {
    addEventListener(type: infer P, ...args: AnyType): void
    addEventListener(type: infer P, ...args: AnyType): void
  }
    ? P & string
    : never

  export interface EachLoop<T> {
    subscription: Subscription<T, unknown>
    current: IteratorResult<T>
    finish: () => void
    stale?: true
  }

  export type Callable<
    T extends Operation<unknown> | Promise<unknown> | unknown,
    TArgs extends unknown[] = [],
  > = (...args: TArgs) => T

  export interface AsyncIterableType<T, TReturn = unknown> {
    [Symbol.asyncIterator](): AsyncIterator<T, TReturn>
  }

  export type All<T extends readonly Operation<unknown>[] | []> = {
    -readonly [P in keyof T]: Yielded<T[P]>
  }

  export type Executor<T> = (
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => () => void

  export interface ScopeInternal extends Scope, AsyncDisposable {
    contexts: Record<string, unknown>
    snapshotKeys: Set<string>
    ensure(op: () => Operation<void>): () => void
  }

  export type Provide<T> = (value: T) => Operation<void>

  export interface TaskOptions<T> {
    owner: Helpers.ScopeInternal
    operation(): Operation<T>
    prioritize?: boolean
  }

  export type AllSettled<T extends readonly Operation<unknown>[] | []> = {
    -readonly [P in keyof T]: Result<Helpers.Yielded<T[P]>, unknown>
  }
}
