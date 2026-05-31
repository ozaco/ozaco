import type { Action, Service } from 'server:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

/**
 * The minimal, type-safe, transport-only client surface generated from backend service
 * definitions. The CLIENT entry carries no server runtime — only these types (erased at build)
 * plus a tiny fetch proxy (see ./index). Method signatures are inferred straight from each
 * `Action`'s own call signature `(...args) => Operation<R, E>`, so there is zero per-endpoint
 * codegen for types; only the runtime route table (`Manifest`) is emitted.
 */
export namespace ClientDef {
  /** One resolved REST route. `path` is the full path including the mount prefix (`/web/hello/:name`). */
  export interface Route {
    method: string
    path: string
  }

  /** The emitted runtime route table: service name -> action key -> route. */
  export type Manifest = Record<string, Record<string, Route>>

  export interface Options {
    /** Origin the API is served from, e.g. `https://api.example.com`. */
    baseUrl: string
    /**
     * Static or lazily-resolved headers (auth, tracing) merged into every request. The transport is
     * `std:fetch`; to stub/SSR/instrument, set its `fetchImpl` context in the running scope.
     */
    headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  }

  /**
   * Lift one action's call signature into a client method. The client mirrors the backend
   * `Action` exactly — same args, same `Operation<R, E>` return — so calls compose with the
   * effect runtime (`yield* client.users.get(...)`), never `async`/`Promise`.
   */
  export type Method<A> = A extends (...args: infer TArgs) => Operation<infer TReturn, infer TError>
    ? (...args: TArgs) => Operation<TReturn, TError>
    : never

  /** Map a service's action map to client methods (non-action members are dropped). */
  export type ServiceClient<TActions> = {
    [K in keyof TActions as TActions[K] extends Action ? K : never]: Method<TActions[K]>
  }

  /** The fully-typed client, inferred from the app's `services` object type. */
  export type Client<TServices> = {
    [S in keyof TServices]: TServices[S] extends Service<AnyType, AnyType, AnyType, infer TActions>
      ? ServiceClient<TActions>
      : never
  }
}
