import type { Context, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Plugin, Protocol } from './plugin'

export namespace Helpers {
  export type InferPluginContext<T> = T extends Plugin<infer V> ? V : never
  export type InferProtocolContext<T> = T extends Protocol<infer V> ? V : never
  export type InferContext<T> = T extends Context<infer V> ? V : never

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

  type KnownKeys<T> = keyof {
    [K in keyof T as string extends K
      ? never
      : number extends K
        ? never
        : symbol extends K
          ? never
          : K]: T[K]
  }

  type Explicit<T> = Pick<T, KnownKeys<T> & keyof T>

  export type Around<T, TE = Explicit<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? AroundFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? Around<TE[K]>
        : never
  }

  export type Before<T, TE = Explicit<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? BeforeFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? Before<TE[K]>
        : never
  }

  export type After<T, TE = Explicit<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? AfterFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? After<TE[K]>
        : never
  }

  export type OnError<T, TE = Explicit<T>> = {
    [K in keyof TE]?: TE[K] extends (...args: AnyType[]) => AnyType
      ? ErrorFn<TE[K]>
      : TE[K] extends Record<string, unknown>
        ? OnError<TE[K]>
        : never
  }

  export interface HookStore {
    around: Array<{ handlers: Record<string, AnyType> }>
    before: Array<{ handlers: Record<string, AnyType> }>
    after: Array<{ handlers: Record<string, AnyType> }>
    error: Array<{ handlers: Record<string, AnyType> }>
    self: Record<string, AnyType>
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
  }
}
