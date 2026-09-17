import type { Context, Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { PROTOCOL } from '../internal/const'

import type { Helpers } from './helpers'
import type { Plugin } from './plugin'

/**
 * A protocol is a contract whose members live under `.actions`, mirroring the api layer:
 * `Db.actions.find(id)`. The control surface (`name`, `version`, `tag`, `description`, `context`,
 * `implement`, `around`, `before`, `after`, `error`) sits on the handle itself.
 */
export type Protocol<
  TContext = unknown,
  TActions extends EmptyType = EmptyType,
  THandlers extends EmptyType = EmptyType,
> = Protocol.Control<TContext, TActions, THandlers> & {
  actions: TActions & THandlers
}

export namespace Protocol {
  export type InferContext<T> = T extends Protocol<infer V> ? V : never

  export interface Control<TContext, TActions, THandlers> {
    _t: typeof PROTOCOL
    _st?: symbol | undefined

    name: string
    version: string
    /** `name@version` — the identity used for contexts and install entries. */
    tag: string
    description?: string | undefined

    /** Holds the active implementation's context value while one of its actions runs. */
    context: Context<TContext>

    around(handlers: Helpers.Around<TActions & THandlers>): Operation<void>
    before(handlers: Helpers.Before<TActions & THandlers>): Operation<void>
    after(handlers: Helpers.After<TActions & THandlers>): Operation<void>
    error(handlers: Helpers.OnError<TActions & THandlers>): Operation<void>

    // setup args are typed HERE, at the implementation — the protocol itself carries no TArgs.
    // The context stays pinned to the protocol's named TContext so handles display cleanly.
    implement<TIContext extends TContext, TIArgs extends unknown[] = []>(options: {
      name: string
      version: string
      description?: string | undefined
      setup(...args: TIArgs): Operation<TIContext>
    }): Implementation<TIContext, TIArgs, TActions>
  }

  export interface Implementation<TContext, TArgs extends unknown[], TActions> {
    context: Context<TContext>

    // ONE argument, two shapes. A literal matching the contract exactly hits the first overload:
    // the CONTRACT type flows through unchanged, so hovers show `Plugin<DbContext, ..., DbActions>`
    // instead of an expanded generator soup. A literal with EXTRA members falls through to the
    // second: contract keys are stripped from the inferred TExtra (Helpers.Extras), custom actions
    // stay callable, and plain values become yieldable operations
    // (`testValue: 12` → `yield* Plugin.actions.testValue`).
    build(actions: TActions): Plugin<TContext, TArgs, TActions>
    build<TExtra extends EmptyType = EmptyType>(
      actions: TActions & TExtra,
    ): Plugin<
      TContext,
      TArgs,
      TExtra extends TActions
        ? TExtra & Helpers.Extras<TExtra, TActions>
        : TActions & Helpers.Extras<TExtra, TActions>
    >
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
   * transport. Pinned plugin calls (`SomePlugin.actions.x(...)`) ignore this and target their own
   * impl.
   */
  export type Exec = (
    entries: Install[],
    run: (entry: Install | undefined) => Operation<unknown>,
  ) => Operation<unknown>
}
