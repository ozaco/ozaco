import type { Schema } from 'db:core'
import type { ObserveDef, ServerDef, ServiceDef } from 'server:core'
import type { AuthDef } from 'server:plugins'
import type { Operation, Scope } from 'std:effect'
import type { TraceDef } from 'std:trace'

export namespace TestingDef {
  export interface NodeOptions {
    readonly services: readonly ServiceDef.Service[]
    readonly plugins?: readonly ServerDef.PluginLike[] | undefined

    /** the app's schema: a memory db is installed with it (unless the scope has a db already). */
    readonly schema?: Schema.Def | undefined

    /** the edge to listen on. Default `BunEdge`. */
    readonly edge?: ServerDef.Options['edge'] | undefined
    readonly name?: string | undefined

    /** anything else `Server.actions.create` takes (`observe`, `trace`, `errors`, …). */
    readonly server?: Partial<ServerDef.Options> | undefined

    /** install a {@link Recorder} as one of the node's exporters — `node.recorder` reads it
     * (the node then observes: every span and log record is kept). */
    readonly record?: boolean | undefined
  }

  /** What a `json` request answers: the status, the parsed body (`null` when empty), the headers. */
  export interface Reply {
    readonly status: number
    readonly body: unknown
    readonly headers: Headers
  }

  export interface JsonInit {
    readonly method?: string | undefined
    readonly body?: unknown
    readonly headers?: Readonly<Record<string, string>> | undefined

    /** a bearer: `authorization: Bearer <token>` (what `node.login` answered). */
    readonly token?: string | undefined
  }

  /** `eventually(pick, options)`. */
  export interface EventuallyOptions {
    /** give up after this long — `server.timeout-unreached` (default 2000). */
    readonly timeoutMs?: number | undefined

    /** how often `pick` is asked again (default 10). */
    readonly everyMs?: number | undefined
  }

  /**
   * A listening node. It lives in a scope of ITS OWN under the test's (two nodes in one test do
   * not tread on each other's edge), so what needs its contexts — a dispatch, the handle's
   * methods, a `useDb` — runs through `effect` / `call`; `request` / `json` are plain HTTP.
   */
  export interface Node {
    readonly url: string
    readonly server: ServerDef.Handle

    /** the recording exporter, with `record: true`; `null` otherwise. */
    readonly recorder: Recorder | null

    /** the node's own scope — where its installs live (`effect` runs there). */
    readonly scope: Scope
    request(path: string, init?: RequestInit): Operation<Response>
    json(path: string, init?: JsonInit): Operation<Reply>

    /** run an operation inside the node's scope (its db, kv, plugins, kernel in context). */
    effect<T>(op: () => Operation<T>): Operation<T>

    /** `server.call`, inside the node's scope. */
    readonly call: ServerDef.Handle['call']

    /** `Auth.actions.login(credentials)` inside the node's scope — the tokens its strategies
     * issue (needs an `Auth` plugin with a strategy that logs in, e.g. `JwtAuth` + `provider`);
     * `node.json(path, { token: tokens.accessToken })` then calls as that user. */
    login(credentials: Record<string, unknown>): Operation<AuthDef.Tokens>
    stop(): Operation<void>
  }

  /** The recording exporter's context: every event shipped, and the readers over it. */
  export interface Recorder extends ObserveDef.ExporterContext {
    readonly shipped: ObserveDef.Event[]
    spans(name?: string): readonly TraceDef.SpanData[]
    logs(pick?: (log: TraceDef.LogData) => boolean): readonly TraceDef.LogData[]

    /** wait for an event (one already shipped answers at once); `server.timeout-unreached`
     * after `timeoutMs` (default 2000). */
    until(
      pick: (event: ObserveDef.Event) => boolean,
      timeoutMs?: number,
    ): Operation<ObserveDef.Event>
  }
}
