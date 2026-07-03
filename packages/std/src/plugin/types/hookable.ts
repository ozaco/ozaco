import type { Context, Operation } from 'std:effect'
import type { AnyType, ExplicitObject } from 'std:shared'

export interface Hookable<TActions> {
  useHook(): Operation<Map<string, unknown>>
  around(handlers: Hookable.Around<TActions>): Operation<void>
  before(handlers: Hookable.Before<TActions>): Operation<void>
  after(handlers: Hookable.After<TActions>): Operation<void>
  error(handlers: Hookable.OnError<TActions>): Operation<void>
}

export namespace Hookable {
  export type AnyAction = (...args: AnyType[]) => Operation<unknown, unknown>

  export type AroundFn<T> = T extends (...args: infer A) => infer R
    ? (args: A, next: (...args: A) => R) => R
    : never

  export type BeforeFn<T> = T extends (...args: infer A) => Operation<unknown, infer E>
    ? (args: A) => Operation<void, E>
    : never

  export type AfterFn<T> = T extends (...args: infer A) => Operation<infer R, infer E>
    ? (result: R, args: A) => Operation<R | void, E>
    : never

  export type ErrorFn<T> = T extends (...args: infer A) => Operation<unknown, infer E>
    ? (error: unknown, args: A) => Operation<void, E>
    : never

  export type Around<T, TE = ExplicitObject<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? AroundFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? Around<TE[K]>
        : never
  }

  export type Before<T, TE = ExplicitObject<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? BeforeFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? Before<TE[K]>
        : never
  }

  export type After<T, TE = ExplicitObject<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? AfterFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? After<TE[K]>
        : never
  }

  export type OnError<T, TE = ExplicitObject<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? ErrorFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? OnError<TE[K]>
        : never
  }

  export interface HookSelfEntry {
    tag: string
    handlers: Record<string, AnyType>
    contextValue: AnyType
    meta?: Map<string, Record<string, AnyType>>
  }

  export interface HookStore {
    around: Array<{ handlers: Record<string, AnyType> }>
    before: Array<{ handlers: Record<string, AnyType> }>
    after: Array<{ handlers: Record<string, AnyType> }>
    error: Array<{ handlers: Record<string, AnyType> }>
    self: HookSelfEntry[]
  }

  export interface RawAction {
    self?: AnyAction | undefined
    context: Context<unknown>
    options: {
      name: string
      version: string
      subtype?: symbol
    }
    key: string
    meta?: Record<string, AnyType>
  }

  export type Exec = (
    entries: Hookable.HookSelfEntry[],
    run: (entry: Hookable.HookSelfEntry | undefined) => Operation<unknown, unknown>,
  ) => Operation<unknown, unknown>

  export interface Call {
    key: string
    args: unknown[]
    arounds: AnyType[]
    befores: AnyType[]
    afters: AnyType[]
    errors: AnyType[]
  }
}
