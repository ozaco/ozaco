import type { Operation } from 'std:effect'
import type { AnyType, EmptyType, ExplicitObject } from 'std:shared'

import type { Plugin } from './plugin'
import type { Protocol } from './protocol'

/**
 * The plugin module's helper shapes: what `definePlugin` / `defineProtocol` are typed as, the
 * hook shapes a protocol's `around` / `before` / `after` / `error` take (`Around`, `Before`,
 * `After`, `OnError`, `Extras`, …) and the runtime's option bag. `Plugin` and `Protocol` — the
 * types a consumer holds — are the module's real surface; nothing here needs a `<Module>Def`.
 */
export namespace Helpers {
  export type DefinePlugin = <TContext, TArgs extends unknown[] = []>(options: {
    subtype?: symbol | undefined

    name: string
    version: string
    description?: string | undefined

    setup(...args: TArgs): Operation<TContext>
  }) => Plugin.Definition<TContext, TArgs>

  export type DefineProtocol = <
    TContext = unknown,
    TActions extends EmptyType = EmptyType,
    THandlers extends EmptyType = EmptyType,
  >(options: {
    subtype?: symbol | undefined
    /** Allow several implementations to be installed side by side (each with its own context). */
    cloneable?: boolean | undefined

    name: string
    version: string
    description?: string | undefined

    /** Protocol-level actions: not tied to an installed impl, always run exactly once. */
    handlers?: THandlers | undefined
    /** Fallback actions used when the dispatched impl does not provide the key. */
    defaults?: Partial<TActions> | undefined

    exec?: Protocol.Exec | undefined
  }) => Protocol<TContext, TActions, THandlers>

  // --- hooks: the per-action wrapper shapes a protocol's around/before/after/error take ---

  export type AnyAction = (...args: AnyType[]) => Operation<unknown>

  export type Dispatch = {
    dispatch(key: string, args: unknown[]): Operation<unknown>
  }

  export type Next = (key: string, args: unknown[]) => Operation<unknown>

  export type Wrap = (
    fn: AnyType,
    call: [key: string, args: unknown[]],
    next: Next,
  ) => Operation<unknown>

  /**
   * The surface of the EXTRA members beyond a contract (`TBase`): contract keys are dropped,
   * Operation-returning functions are normalized to `(...args) => Operation<R>` for clean hovers,
   * and plain values are exposed as yieldable operations (`testValue: 12` →
   * `yield* Plugin.actions.testValue`), exactly like value members on an effect api. The trailing
   * conditional forces eager evaluation so hovers show the resolved object instead of the raw
   * inferred literal.
   */
  export type Extras<T, TBase = EmptyType> = {
    [K in keyof T as K extends keyof TBase ? never : K]: T[K] extends (
      ...args: infer A
    ) => Operation<infer R>
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

  /** What `createProtocolRuntime` takes — `defineProtocol`'s options minus the description. */
  export interface RuntimeOptions {
    name: string
    version: string
    subtype?: symbol | undefined
    cloneable?: boolean | undefined
    handlers?: Record<string, AnyType> | undefined
    defaults?: Record<string, AnyType> | undefined
    exec?: Protocol.Exec | undefined
  }
}
