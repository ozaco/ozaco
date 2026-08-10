import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Context, Operation, Scope, Stream, Subscription } from './operation'

/**
 * An API whose implementation can be decorated within a scope — the runtime half of the
 * algebraic-effect context system (Effection v4.1 experimental). Create one with `createApi`.
 */
export interface Api<A> {
  operations: {
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

export type Middleware<TArgs extends unknown[], TReturn> = (
  args: TArgs,
  next: (...args: TArgs) => TReturn,
) => TReturn

export type Around<A> = {
  [K in keyof A]: A[K] extends (...args: infer TArgs) => infer TReturn
    ? Middleware<TArgs, TReturn>
    : Middleware<[], A[K]>
}

export namespace Utils {
  export interface Decorator<A> {
    min?: Partial<Around<A>> | undefined
    max?: Partial<Around<A>> | undefined
  }

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

  export interface ScopeApi {
    create(parent: Scope): [Scope, () => Operation<void>]
    destroy(scope: Scope): Operation<void>
    set<T>(scope: Scope, context: Context<T>, value: T): T
    delete<T>(scope: Scope, context: Context<T>): boolean
  }

  export interface Apis {
    scope: Api<ScopeApi>
  }

  export interface Each {
    <T>(stream: Stream<T, unknown>): Operation<Iterable<T>>
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
}
