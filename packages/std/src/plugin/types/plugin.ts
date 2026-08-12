import type { Context, Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { PLUGIN } from '../const'

import type { Hooks } from './hooks'

/**
 * A built implementation. Its action members live under `.actions`, mirroring the api layer, and
 * always target THIS implementation (`SqliteDb.actions.find(id)`) even when the protocol has
 * several installs. The control surface (`name`, `version`, `tag`, `description`, `context`,
 * `setup`, `getKeys`, `getMeta`) sits on the handle itself.
 */
export type Plugin<
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TActions = EmptyType,
> = Plugin.Control<TContext, TArgs> & {
  actions: TActions
}

export namespace Plugin {
  export type InferContext<T> = T extends Plugin<infer V> ? V : never

  export interface Control<TContext, TArgs extends unknown[]> {
    _t: typeof PLUGIN
    _st?: symbol | undefined

    name: string
    version: string
    /** `name@version` — the identity used for install entries and pinned dispatch. */
    tag: string
    description?: string | undefined

    context: Context<TContext>

    setup(...args: TArgs): Operation<TContext>
    getKeys(): string[]
    getMeta(key: string): Record<string, AnyType> | undefined
  }

  export interface Definition<TContext, TArgs extends unknown[]> {
    context: Context<TContext>

    build(): Plugin<TContext, TArgs, EmptyType>
    // standalone plugins have no contract: the whole literal is normalized api-style
    // (functions → (...args) => Operation<R>, values → Operation<V>)
    build<TActions extends EmptyType>(
      actions: TActions,
    ): Plugin<TContext, TArgs, Hooks.Extras<TActions>>
  }
}
