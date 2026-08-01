import type { Future } from 'std:effect'
import type { Plugin, Protocol } from 'std:plugin'
import type { AnyType, EmptyType } from 'std:shared'

import type { SERVICE } from '../const'

import type { Action } from './action'

/**
 * A service is a {@link Protocol} whose self-actions are its own route table.
 *
 * A protocol rather than a plain plugin, because a service has to answer questions about itself —
 * which addresses does it serve, what is the action at this path — and a plugin has nowhere to put
 * them. The table those questions read is a real `Map` built at definition time, NOT a walk over
 * `service.actions`: that is a `createProxy`, and a proxy answers every key with another callable
 * proxy, so a `_has` implemented over it reports `true` for a path nobody defined.
 */
export interface Service<
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TActions extends EmptyType = EmptyType,
> extends Protocol<TContext, TArgs, TActions, Service.Handlers<TContext, TArgs, TActions>> {
  _st: typeof SERVICE
}

export namespace Service {
  /** The actions record a service was defined with. */
  export type ActionsOf<TService> =
    TService extends Service<AnyType, AnyType[], infer TActions> ? TActions : never

  /**
   * Every callable path, dotted exactly as `flatten` produced it — `create`, `admin.purge`.
   *
   * Constraining an address to this is what turns a typo into a compile error instead of a runtime
   * miss, and it is why an address stays two plain values rather than one opaque string: a
   * formatted `"notes#admin.purge"` cannot be checked against anything.
   */
  export type PathsIn<TActions, TDepth extends unknown[] = []> = TDepth['length'] extends 5
    ? never
    : {
        [K in keyof TActions & string]: TActions[K] extends Action<AnyType[], AnyType>
          ? K
          : TActions[K] extends Record<string, AnyType>
            ? `${K}.${PathsIn<TActions[K], [unknown, ...TDepth]> & string}`
            : never
      }[keyof TActions & string]

  export type Paths<TService> = PathsIn<ActionsOf<TService>>

  /** Walk a dotted path into the actions record. */
  export type At<TActions, TPath extends string> = TPath extends `${infer Head}.${infer Rest}`
    ? Head extends keyof TActions
      ? At<TActions[Head], Rest>
      : never
    : TPath extends keyof TActions
      ? TActions[TPath]
      : never

  /** What the action at `TPath` returns — so a call's outcome is typed, not `unknown`. */
  export type Returns<TService, TPath extends string> =
    At<ActionsOf<TService>, TPath> extends Action<AnyType[], infer TReturn> ? TReturn : unknown

  /** The args tuple the action at `TPath` declares — what a call's normal sources carry, in order.
   * Falls back to `unknown[]` (an unconstrained call) when the action is untyped. */
  export type Args<TService, TPath extends string> =
    At<ActionsOf<TService>, TPath> extends Action<infer TArgs, AnyType> ? TArgs : unknown[]

  /** What a claim puts in a routing table: the action plus who owns the address. */
  export interface Route {
    service: Service
    action: Action
    /** the dotted key this action answers to, kept so a carrier can be told what to serve */
    path: string
  }

  export interface Handlers<TContext, TArgs extends unknown[], TActions extends EmptyType> {
    /**
     * Compile and install in one step: `yield* AuthService.actions.install()`.
     *
     * The reason a service is never handed to the bare `install()` — a protocol is not installable,
     * only the plugin that `_compile()` seals out of it is. Not underscored, because unlike the
     * lookups this is the public verb.
     */
    install(...args: TArgs): Future<TContext>

    /**
     * Underscored because they are plumbing — and because an author's own `get`/`list` action must
     * not collide with the service's own vocabulary. That collision is why the prefix exists.
     */
    _has(path: string): Future<boolean>
    _get(path: string): Future<Action | undefined>
    _list(): Future<[path: string, action: Action][]>

    /** the dotted path an action answers to, or `undefined` if it is not ours */
    _pathOf(action: Action): Future<string | undefined>

    /**
     * The seal — the last moment at which every declaration is present and nothing is wired yet.
     *
     * Built through the protocol's own `implement`, NOT a fresh `definePlugin`: that shares the
     * protocol's context, so `useContext(service)` inside an action resolves to what `setup`
     * returned. A separately defined plugin would carry a context of its own, and the service would
     * be unable to see its own state.
     */
    _compile(): Future<Plugin<TContext, TArgs, TActions>>
  }
}
