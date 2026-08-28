import type { OptionsDef, ServerDef } from 'server:core'

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

  export interface PluginOptions {
    /** key namespace inside the Kv store. Default `'cache'`. */
    readonly prefix?: string | undefined

    /** watch these db tables (all declared ones by default) and invalidate their tags on change. */
    readonly tables?: readonly string[] | false | undefined
  }
}
