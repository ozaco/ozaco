import type { CodecDef } from 'std:codec'
import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { Features } from './const'

export type ConfigDef = Plugin<
  ConfigDef.Context,
  unknown,
  [options?: ConfigDef.Options],
  ConfigDef.Actions
>

export namespace ConfigDef {
  /** A Codec parsed object (config values are plain data). */
  export type Object = Record<string, unknown>

  /** A search hit: the dotted key and the value found at it in the merged config. */
  export interface Match {
    key: string
    value: unknown
  }

  export interface Source {
    path: string
    data: ConfigDef.Object
    extends: ConfigDef.Source[]
  }

  /** The single file `set`/`remove`/`clear`/`save` operate on (default the cwd base file). */
  export interface Working {
    path: string
    data: ConfigDef.Object
  }

  export interface Options {
    /** Target codec (default `TomlCodec`). */
    codec?: CodecDef

    /** Config name (default `ozaco`). */
    name?: string

    /** Directory to start discovery from (default `process.cwd()`). */
    cwd?: string

    /** Active variant overlay name (`<veriant>.<name>.toml` wins); default the `STD_CONFIG` env var. */
    variant?: string

    /** Directory to stop discovery at, inclusive (default the home dir). */
    home?: string

    /** Config dir/file should start with dot (default `true`). */
    dot?: boolean

    /** File extension without the dot (default derived from the codec, e.g. `toml`). */
    ext?: string

    /** Enabled config features (default `Features.ALL`). */
    features?: Features
  }

  export interface Context {
    name: string
    cwd: string
    dot: boolean
    ext: string
    codec: CodecDef

    variant?: string | undefined
    home: string
    features: Features

    /** Discovered chain, innermost → outermost. Per dir: variant → fragments → base (`extends` resolved). */
    chain: ConfigDef.Source[]
    /** Env overlay (`ENV` feature), applied as the highest-precedence source over the chain. */
    env: ConfigDef.Object
    /** The merged view produced by the last `load` (chain merged low → high, then `env` on top). */
    merged: ConfigDef.Object
    /** The file `set`/`remove`/`clear`/`save` mutate in memory. */
    working: ConfigDef.Working
  }

  export interface Actions {
    /** (Re)discover `<name>.toml` from cwd up to home, resolve `extends`, return the merged config. */
    load(cwd?: string): Future<void, unknown>
    /** Re-run discovery against the current cwd (pick up on-disk changes) without moving `cwd`. */
    refresh(): Future<void, unknown>
    /** Write the working file's own content as TOML (default the cwd `<name>.toml`, or `path`). */
    save(path?: string): Future<void, unknown>

    /** Read a dotted key (`a.b.c`) from the merged config; omit `key` for the whole merged object. */
    get<T>(key?: string): Future<T, unknown>
    /** Set a dotted key in the working file's content (in memory; call `save` to persist). */
    set(key: string, value: unknown): Future<void, unknown>
    /** Remove a dotted key from the working file's content (in memory; call `save` to persist). */
    remove(key: string): Future<void, unknown>
    /** Empty the working file's content (in memory; call `save` to persist). */
    clear(): Future<void, unknown>
    /** Delete a config FILE (default the working file), then re-discover. */
    delete(path?: string): Future<void, unknown>
    /** Find merged entries whose dotted key or value contains `query` (case-insensitive). */
    search(query: string): Future<ConfigDef.Match[], unknown>
    /** The discovered chain (parents) with each file's `extends` locations, as a tree. */
    tree(): Future<ConfigDef.Source[], unknown>
  }
}
