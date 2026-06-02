import type { Action, BrokerDef, Service } from 'server:core'
import type { Operation } from 'std:effect'

/**
 * The client mirrors the server's broker pipeline with the transport leaf removed: the broker's
 * dispatch core talks to the remote server DIRECTLY over `std:fetch` (no `Transport` protocol),
 * routed by the emitted route `Manifest`. Action/service/codec/policy/tracer are reused from
 * `server:core` verbatim — only the broker (this file's `ClientBroker`) and the std:fetch dispatch
 * core are new.
 */
export namespace ClientDef {
  /** One resolved REST route. `path` is the full path including the mount prefix (`/web/hello/:name`). */
  export interface Route {
    method: string
    path: string
  }

  /** The emitted runtime route table: service name -> action key -> route. */
  export type Manifest = Record<string, Record<string, Route>>

  export interface Options extends BrokerDef.Options {
    /** Origin the remote server is served from, e.g. `https://api.example.com`. */
    baseUrl: string
    /** The route table emitted by `@ozaco/unplugin-client`. */
    manifest: Manifest
    /** Static or lazily-resolved headers (auth, tracing) merged into every request. */
    headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  }

  export interface Context extends BrokerDef.Context {
    baseUrl: string
    manifest: Manifest
    headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  }

  /** Lift one backend action's call signature into a client action (mirrors it exactly). */
  type ActionFn<A> = A extends (...args: infer TArgs) => Operation<infer TReturn, infer TError>
    ? (...args: TArgs) => Operation<TReturn, TError>
    : never

  /** The nested, per-route call surface inferred from the app's `services` object type. */
  export type Actions<TServices> = {
    [S in keyof TServices]: TServices[S] extends { actions: infer TActions }
      ? { [A in keyof TActions as TActions[A] extends Action ? A : never]: ActionFn<TActions[A]> }
      : never
  }

  /** A generated client service stub (a real `Service` whose action bodies dispatch remotely). */
  export type Stub<TService> = TService extends { actions: infer TActions }
    ? Service<unknown, unknown, [], TActions>
    : never
}
