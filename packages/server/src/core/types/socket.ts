import type { StreamQueue } from 'std:effect'

import type { SERVICE } from '../const'

import type { Action } from './action'
import type { GatewayDef } from './gateway'
import type { Service } from './service'

/**
 * A live connection, defined the way a service is — and it IS one: register it, mount it, list it
 * as a daemon module like any other. Deliberately rigid where a service is open: its install args
 * are PINNED to `[SocketService.Options?]` — which is what makes `install(chat, { munt: '/chat' })`
 * a compile error instead of a line that silently wires nothing — and its actions are PINNED to the
 * single `connect`.
 *
 * There is no room for custom actions here on purpose. A socket that also needs REST endpoints is a
 * normal `defineService` with `socketAction` among its actions; keeping both doors would just be
 * two ways to say the same thing.
 */
export interface SocketService extends Service<
  unknown,
  [options?: SocketService.Options],
  SocketService.Actions
> {
  _st: typeof SERVICE
}

export namespace SocketService {
  /**
   * What `install(socket, …)` can wire up for you. Passing anything here turns on self-wiring: the
   * socket registers itself where it is OWNED and mounts itself where it is SERVED, which under a
   * daemon means the same `install` line is a headless worker in one pod and a route-only edge in
   * another. Install with no options and nothing implicit happens.
   */
  export interface Options {
    /** Gateway prefix to mount the service's routes under, e.g. `'/chat'`. */
    mount?: string
  }

  /** The only action a socket carries: a `session` connection is a single dispatch. */
  export interface Actions {
    connect: Action<[body?: unknown], StreamQueue<unknown, void>>
  }

  /** The route-level half — all `socketAction` needs to build the single `connect`. */
  export interface Route {
    /** Route path, relative to wherever the socket is mounted. Defaults to `/`. */
    path?: string
    title?: string
    description?: string
  }

  /**
   * Everything but the handlers, which `defineSocket` takes as its second argument.
   *
   * No `setup`: a socket IS its handlers, and its context is fixed at `unknown`, so a setup here
   * could produce a value nothing could ever read back. Reach for `socketAction` inside a normal
   * `defineService` when the connection needs to sit next to real lifecycle state.
   */
  export interface Config extends Route {
    name: string
    version?: string
  }

  /** The handler object — the same one `Gateway.actions.listen` takes. */
  export type Handlers = GatewayDef.ListenHandlers
}
