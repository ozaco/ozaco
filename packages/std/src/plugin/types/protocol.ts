import type { Context, Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { PROTOCOL } from '../const'

import type { Hooks } from './hooks'
import type { Plugin } from './plugin'

/**
 * A protocol is a contract whose members live under `.actions`, mirroring the api layer:
 * `Db.actions.find(id)`. The control surface (`name`, `version`, `tag`, `context`, `implement`,
 * `around`, `before`, `after`, `error`) sits on the handle itself.
 */
export type Protocol<
  TActions = EmptyType,
  TContext = unknown,
  THandlers = EmptyType,
> = Protocol.Control<TActions, THandlers, TContext> & {
  actions: TActions & THandlers
}

export namespace Protocol {
  export type InferContext<T> = T extends Protocol<EmptyType, infer V> ? V : never

  export interface Control<TActions, THandlers, TContext> {
    _t: typeof PROTOCOL
    _st?: symbol | undefined

    name: string
    version: string
    /** `name@version` — the identity used for contexts and install entries. */
    tag: string
    description?: string | undefined

    /** Holds the active implementation's context value while one of its actions runs. */
    context: Context<TContext>

    around(handlers: Hooks.Around<TActions & THandlers>): Operation<void>
    before(handlers: Hooks.Before<TActions & THandlers>): Operation<void>
    after(handlers: Hooks.After<TActions & THandlers>): Operation<void>
    error(handlers: Hooks.OnError<TActions & THandlers>): Operation<void>

    // setup args are typed HERE, at the implementation — the protocol itself carries no TArgs.
    // The context stays pinned to the protocol's named TContext so handles display cleanly.
    implement<TIArgs extends unknown[] = []>(options: {
      name: string
      version: string
      description?: string
      setup(...args: TIArgs): Operation<TContext>
    }): Implementation<TActions, TContext, TIArgs>
  }

  export interface Implementation<TActions, TContext, TArgs extends unknown[] = never> {
    context: Context<TContext>

    // the CONTRACT type flows through unchanged — no inference from the literal, so hovers show
    // `Plugin<DbActions, DbContext, ...>` instead of an expanded generator soup. Extra value
    // members map api-style to yieldable operations (`testValue: 12` → `yield* Plugin.testValue`).
    // TExtra defaults to EmptyType (not never) so a mistyped extras literal produces ONLY the real
    // error (implicit-any params) instead of a misleading "not assignable to undefined"
    build<TBuildedActions extends TActions>(
      actions: TBuildedActions,
    ): Plugin<Hooks.Values<TBuildedActions>, TContext, TArgs>
  }

  /** One installed implementation, as stored in the scope-local install registry. */
  export interface Install {
    tag: string
    value: unknown
    /** Wrapped action operations, plus raw value members dispatched as-is. */
    actions: Record<string, AnyType>
    meta: Map<string, Record<string, AnyType>>
  }

  /**
   * Controls how protocol-level action calls execute across installed impls (default: run the
   * last-installed impl and return its result). `run(entry)` executes the action against one impl
   * (applying its context) and returns the result; `exec` decides which/how many to run — e.g. a
   * codec protocol runs the highest-priority codec, a fan-out protocol (logger) runs every
   * transport. Pinned plugin calls (`SomePlugin.x(...)`) ignore this and target their own impl.
   */
  export type Exec = (
    entries: Install[],
    run: (entry: Install | undefined) => Operation<unknown>,
  ) => Operation<unknown>
}
