import type { Action, BrokerDef, Service } from 'server:core'
import type { Future, Operation, Stream } from 'std:effect'
import type { Result } from 'std:result'

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

  /**
   * How a remote endpoint's response is consumed:
   * - `body`   — read the whole response, decode it once with the codec (the default).
   * - `stream` — pipe the response body through the codec's streaming decoder (one value per chunk).
   * - `raw`    — hand back the undecoded byte stream as-is.
   */
  export type DispatchMode = 'body' | 'stream' | 'raw'

  /** Per-call options, threaded to the std:fetch dispatch core (adds `mode` to the broker's set). */
  export interface CallOptions extends BrokerDef.CallOptions {
    mode?: DispatchMode
  }

  /** The close value a codec stream settles with: `true` on a clean end, or a failure mid-stream. */
  type StreamClose = true | Result.Failure<unknown>

  /** The item a streamed response yields: an array's element type, else the value itself. */
  type StreamItem<T> = T extends readonly (infer E)[] ? E : T

  /**
   * The three ways to consume one remote endpoint's response. Calling an endpoint with its args
   * returns this handle; you then pick a mode — every endpoint supports all three.
   *
   *   const call = api.todos.actions.list({ page: 1 })
   *   const todos = yield* call.body()                          // Future<Todo[]>
   *   for (const todo of yield* each(yield* call.stream())) {}  // Stream<Todo>
   *   for (const chunk of yield* each(yield* call.raw())) {}    // Stream<Uint8Array>
   */
  export interface Endpoint<T, E> {
    /** Codec-decoded full body. */
    body(): Future<T, E>
    /** Codec-decoded stream of response chunks (one decoded value per chunk). */
    stream<U = StreamItem<T>>(): Future<Stream<U, StreamClose>, E>
    /** Raw, undecoded stream of response bytes. */
    raw(): Future<Stream<Uint8Array, StreamClose>, E>
  }

  /** Lift one backend action's call signature into a client endpoint factory (mirrors its args). */
  type EndpointFn<A> = A extends (...args: infer TArgs) => Operation<infer TReturn, infer TError>
    ? (...args: TArgs) => Endpoint<TReturn, TError>
    : never

  /** The nested, per-route call surface inferred from the app's `services` object type. */
  export type Client<TServices> = {
    [S in keyof TServices]: TServices[S] extends { actions: infer TActions }
      ? {
          actions: {
            [A in keyof TActions as TActions[A] extends Action ? A : never]: EndpointFn<TActions[A]>
          }
        }
      : never
  }

  /** A generated client service stub (a real `Service` whose action bodies dispatch remotely). */
  export type Stub<TService> = TService extends { actions: infer TActions }
    ? Service<unknown, unknown, [], TActions>
    : never
}
