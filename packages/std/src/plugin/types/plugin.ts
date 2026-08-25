import type { Context, Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { PLUGIN, USE } from '../const'

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

  /**
   * The install of a plugin as an Operation (`yield*` it where the plugin should live) that also
   * names the plugin and its arguments — what consumers such as `createServer({ plugins })` take,
   * so they can both install it and keep its handle.
   */
  export interface Use<TContext, TArgs extends unknown[]> extends Operation<TContext> {
    readonly _t: typeof USE
    readonly plugin: Plugin<TContext, TArgs, AnyType>
    readonly args: TArgs
  }

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
    /** The install with these arguments as an Operation (`yield* X.use(...)`), which also names
     * the plugin — what consumers such as `createServer({ plugins })` take. */
    use(...args: TArgs): Use<TContext, TArgs>
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
