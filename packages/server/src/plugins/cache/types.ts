import type { OptionsDef, ServerDef } from 'server:core'
import type { Operation } from 'std:effect'

export namespace CacheDef {
  /** The `cache` action option — see {@link OptionsDef.Cache}. */
  export type Options = OptionsDef.Cache

  /** What the cache key is built from. */
  export interface KeyInput {
    readonly prefix: string
    readonly call: ServerDef.Call
    readonly ctx: ServerDef.Ctx
    readonly cache: Options
  }

  /** One cached dispatch: the key material plus the rest of the chain (the handler on a miss). */
  export interface LookupInput extends KeyInput {
    readonly next: ServerDef.Dispatch
  }

  /**
   * What an entry holds in the Kv store: the answer (`v`) and the W3C `traceparent` of the
   * `cache {service}.{action}` span that computed it (`tp`, absent when that span did not
   * record) — a later hit LINKS it (`ozaco.link.reason = 'cache.producer'`). A stored value
   * without the `$oz` marker (written before the envelope existed) is served as is, unlinked.
   */
  export interface Entry {
    readonly $oz: 1
    readonly v: unknown
    readonly tp?: string | undefined
  }

  export interface PluginOptions {
    /** key namespace inside the Kv store. Default `'cache'`. */
    readonly prefix?: string | undefined

    /** watch these db tables (all declared ones by default) and invalidate their tags on change. */
    readonly tables?: readonly string[] | false | undefined
  }

  /** A change feed of one table (`DbClient`'s `changes(table)` subscription). */
  export interface Feed {
    next(): Operation<IteratorResult<FeedEvent, unknown>>
  }

  /** The part of a `Change.Event` the cache reads: the writer's bus meta (`traceparent`, …). */
  export interface FeedEvent {
    readonly meta?: Readonly<Record<string, string>> | undefined
  }
}
