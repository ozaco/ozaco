import type { Maybe, Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { API } from '../const'

import type { Api, Around, Context, Future, Operation, Scope, Subscription } from './operation'

export namespace Helpers {
  export type Resolve<T> = (value: T) => void

  export type Provide<T> = (value: T) => Operation<void>

  export type Executor<T> = (
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => () => void

  export type Callable<
    T extends Operation<unknown> | Promise<unknown> | unknown,
    TArgs extends unknown[] = [],
  > = (...args: TArgs) => T

  export type Effect<T> = {
    enter: (
      resolve: Resolve<Result<T>>,
      routine: Coroutine,
    ) => (resolve: Resolve<Result<void>>) => void
    cause: string
  }

  export interface CoroutineOptions<T> {
    scope: Scope
    operation(): Operation<T>
  }

  export interface Coroutine<T = unknown> {
    future: Future<Maybe<Result<T>>>
    scope: Scope
    data: {
      exit(resolve: Resolve<Result<unknown>>): void
      enqueued: boolean
      critical: boolean
      unwinding: boolean
      resumeWith: Result<unknown>
    }
    resume(result: Result<unknown>): void
    step(): IteratorResult<Effect<unknown>, T>
    unwind(): void
    perform(effect: Effect<unknown>): void
    settle(outcome: Maybe<Result<T>>): void
  }

  export interface WithResolvers<T> {
    operation: Operation<T>
    resolve(value: T): void
    reject(error: unknown): void
  }

  export type Settleware = (
    outcome: Maybe<Result<unknown>>,
    next: (outcome: Maybe<Result<unknown>>) => void,
  ) => void

  export interface ErrorBoundary {
    raise(error: unknown): void
  }

  export interface ScopeInternal extends Scope, AsyncDisposable {
    contexts: Record<string, unknown>
    ensure(op: () => Operation<void>): () => void
    destroy(): Operation<void>
  }

  export interface TaskOptions<T> {
    owner: ScopeInternal
    operation(): Operation<T>
    prioritize?: boolean | undefined
    /** Detached tasks deliver failures ONLY through their future — they never crash the owner. */
    detached?: boolean | undefined
  }

  export interface EachLoop<T> {
    subscription: Subscription<T, unknown>
    current: IteratorResult<T>
    finish: () => void
    stale?: true
  }

  export type EventTypeFromEventTarget<T, K extends string> = `on${K}` extends keyof T
    ? Parameters<Extract<T[`on${K}`], (...args: AnyType[]) => AnyType>>[0]
    : Event

  export type EventList<T> = T extends {
    addEventListener(type: infer P, ...args: AnyType): void
    addEventListener(type: infer _P2, ...args: AnyType): void
  }
    ? P & string
    : never

  export interface AsyncIterableType<T, TReturn = unknown> {
    [Symbol.asyncIterator](): AsyncIterator<T, TReturn>
  }

  export interface FutureWithResolvers<T> {
    future: Future<T>
    resolve(value: T): void
    reject(error: Result.Failure<unknown>): void
  }

  export interface ScopeApi {
    create(parent: Scope): [Scope, () => Operation<void>]
    destroy(scope: Scope): Operation<void>
    set<T>(scope: Scope, context: Context<T>, value: T): T
    delete<T>(scope: Scope, context: Context<T>): boolean
  }

  export interface Apis {
    scope: Api<ScopeApi>
  }

  export interface Decorator<A> {
    min?: Partial<Around<A>> | undefined
    max?: Partial<Around<A>> | undefined
  }

  export interface ApiState<A> {
    local: Decorator<A>
    total: Decorator<A>
    handle: A
  }

  export interface ApiInternal<A> extends Api<A> {
    _t: typeof API

    context: Context<ApiState<A>>
    core: A
  }
}
