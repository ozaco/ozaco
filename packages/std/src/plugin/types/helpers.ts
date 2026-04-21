import type { Context, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Plugin, Protocol } from './plugin'

export namespace Helpers {
  export type InferPluginContext<T> = T extends Plugin<infer V> ? V : never
  export type InferProtocolContext<T> = T extends Protocol<infer V> ? V : never
  export type InferContext<T> = T extends Context<infer V> ? V : never

  export interface Use {
    <T extends Context<AnyType>>(ctx: T): Helpers.InferContext<T>
    <T extends Plugin>(plugin: T): Helpers.InferPluginContext<T>
    <T extends Protocol>(ns: T): Helpers.InferProtocolContext<T>
  }

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

  export type Around<T> = {
    [K in keyof T]?: T[K] extends (...args: AnyType[]) => AnyType
      ? AroundFn<T[K]>
      : T[K] extends Record<string, unknown>
        ? Around<T[K]>
        : never
  }

  export type Before<T> = {
    [K in keyof T]?: T[K] extends (...args: AnyType[]) => AnyType
      ? BeforeFn<T[K]>
      : T[K] extends Record<string, unknown>
        ? Before<T[K]>
        : never
  }

  export type After<T> = {
    [K in keyof T]?: T[K] extends (...args: AnyType[]) => AnyType
      ? AfterFn<T[K]>
      : T[K] extends Record<string, unknown>
        ? After<T[K]>
        : never
  }

  export type OnError<T> = {
    [K in keyof T]?: T[K] extends (...args: AnyType[]) => AnyType
      ? ErrorFn<T[K]>
      : T[K] extends Record<string, unknown>
        ? OnError<T[K]>
        : never
  }

  export interface HookStore {
    around: Array<{ handlers: Record<string, AnyType> }>
    before: Array<{ handlers: Record<string, AnyType> }>
    after: Array<{ handlers: Record<string, AnyType> }>
    error: Array<{ handlers: Record<string, AnyType> }>
    self: Record<string, AnyType>
  }
}
