import type { ServerDef } from 'server:core'

export namespace CacheDef {
  /** The `cache` action option. */
  export interface Options {
    readonly ttlMs: number

    /** what the key varies on besides the whole input: dotted paths into `input` / `auth` /
     * `headers` (e.g. `'auth.id'`, `'headers.accept-language'`). Default: the whole input. */
    readonly vary?: readonly string[] | undefined

    /** tags the entry carries (`invalidate` drops them; a db table name is invalidated
     * automatically when that table changes). */
    readonly tags?: readonly string[] | undefined
  }

  /** What the cache key is built from. */
  export interface KeyInput {
    readonly prefix: string
    readonly call: ServerDef.Call
    readonly ctx: ServerDef.Ctx
    readonly cache: Options
  }

  export interface PluginOptions {
    /** key namespace inside the Kv store. Default `'cache'`. */
    readonly prefix?: string | undefined

    /** watch these db tables (all declared ones by default) and invalidate their tags on change. */
    readonly tables?: readonly string[] | false | undefined
  }
}
