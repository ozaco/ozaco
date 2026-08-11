import type { Operation } from 'std:effect'
import type { AnyType, ExplicitObject } from 'std:shared'

export namespace Hooks {
  export type AnyAction = (...args: AnyType[]) => Operation<unknown>

  /**
   * Api-style mapping for extra members: functions stay as written, plain values are exposed as
   * yieldable operations (`testValue: 12` → `yield* Plugin.testValue`), exactly like value members
   * on an effect api. The trailing conditional forces eager evaluation so hovers show the resolved
   * object.
   */
  export type Values<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => Operation<infer R>
      ? (...args: A) => Operation<R>
      : T[K] extends (...args: AnyType[]) => AnyType
        ? T[K]
        : Operation<T[K]>
  } extends infer O
    ? { [K in keyof O]: O[K] }
    : never

  export type AroundFn<T> = T extends (...args: infer A) => infer R
    ? (args: A, next: (...args: A) => R) => R
    : never

  export type BeforeFn<T> = T extends (...args: infer A) => Operation<unknown>
    ? (args: A) => Operation<void>
    : never

  export type AfterFn<T> = T extends (...args: infer A) => Operation<infer R>
    ? (result: R, args: A) => Operation<R | void>
    : never

  export type ErrorFn<T> = T extends (...args: infer A) => Operation<unknown>
    ? (error: unknown, args: A) => Operation<void>
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
}
