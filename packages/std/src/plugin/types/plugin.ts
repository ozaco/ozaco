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
  TActions = EmptyType,
  TContext = unknown,
  TArgs extends unknown[] = never,
> = Plugin.Control<TContext, TArgs> & {
  actions: TActions
}

export namespace Plugin {
  export type InferContext<T> = T extends Plugin<EmptyType, infer V> ? V : never

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

    build(): Plugin<EmptyType, TContext, TArgs>
    build<TActions extends EmptyType, TExtra extends EmptyType = EmptyType>(
      actions: TActions,
      extra?: TExtra,
    ): Plugin<
      keyof TExtra extends never ? TActions : TActions & Hooks.Values<TExtra>,
      TContext,
      TArgs
    >
  }
}
