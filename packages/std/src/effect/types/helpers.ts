import type { Failure, Result } from 'std:result'
import type { AnyFunction, AnyType } from 'std:shared'

import type { Future, Operation, Scope, Subscription } from './operation'

export namespace Helpers {
  export type Yielded<T extends Operation<unknown, AnyType>> =
    T extends Operation<infer TYield, AnyType> ? TYield : never

  export type YieldedError<T extends Operation<unknown, AnyType>> =
    T extends Operation<AnyType, infer TError> ? TError : never

  export interface ErrorBoundary {
    raise(error: unknown): void
  }

  export type Instruction = [
    number,
    Helpers.Coroutine<unknown>,
    Result<unknown, unknown>,
    () => boolean,
    'return' | 'next',
  ]

  export type FailureOf<E> = [E] extends [never] ? never : Failure<E>

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
    data: {
      exit(resolve: Helpers.Resolve<Result<unknown, unknown>>): void
      iterator: Iterator<Effect<unknown> | Failure<never>, T, unknown>
    }
    next(result: Result<unknown, unknown>): void
    return<R>(result: Result<R, unknown>): void
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

  export interface HostOperation<T, E> {
    deno(): Operation<T, E>
    node(): Operation<T, E>
    bun(): Operation<T, E>
    browser(): Operation<T, E>
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

  export type All<T extends readonly Operation<unknown, unknown>[] | []> = {
    -readonly [P in keyof T]: Yielded<T[P]>
  }

  export type Executor<T> = (
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => () => void

  export interface ScopeInternal extends Scope, AsyncDisposable {
    contexts: Record<string, unknown>
    ensure(op: () => Operation<void>): () => void
  }

  export type Provide<T> = (value: T) => Operation<void>
}
