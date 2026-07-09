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
    codec?: CodecDef | undefined

    /** Config name (default `ozaco`). */
    name?: string | undefined

    /** Directory to start discovery from (default `process.cwd()`). */
    cwd?: string | undefined

    /** Active variant overlay name (`<variant>.<name>.toml` wins); default the `STD_CONFIG` env var. */
    variant?: string | undefined

    /** Directory to stop discovery at, inclusive (default the home dir). */
    home?: string | undefined

    /** Config dir/file should start with dot (default `true`). */
    dot?: boolean | undefined

    /** File extension without the dot (default derived from the codec, e.g. `toml`). */
    ext?: string | undefined

    /** Enabled config features (default `Features.ALL`). */
    features?: Features | undefined
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
    /** The base file `clear` empties and new keys from `set` land in (the cwd base file). */
    working: ConfigDef.Working
    /** Paths of source files edited by `set`/`remove`/`clear` since the last `load`, flushed by `save`. */
    dirty: Set<string>
  }

  /** A self-contained config: its own discovery/merge/working file. The default one is `Config`'s
   * own actions; `open` mints extra, fully-independent instances. */
  export interface Instance {
    /** (Re)discover `<name>.toml` from cwd up to home, resolve `extends`, return the merged config. */
    load(cwd?: string): Future<void, unknown>
    /** Re-run discovery against the current cwd (pick up on-disk changes) without moving `cwd`. */
    refresh(): Future<void, unknown>
    /** Persist edits: no arg writes every file `set`/`remove`/`clear` touched back to its own path;
     * a `path` exports the base working file's content there instead. */
    save(path?: string): Future<void, unknown>

    /** Read a dotted key (`a.b.c`) from the merged config; omit `key` for the whole merged object. */
    get<T>(key?: string): Future<T, unknown>
    /** Set a dotted key in the file that owns it or its nearest existing ancestor path (else the base
     * working file); reflected in the merge at once, `save` to persist. */
    set(key: string, value: unknown): Future<void, unknown>
    /** Remove a dotted key from the file that currently provides it (in memory; call `save` to persist). */
    remove(key: string): Future<void, unknown>
    /** Empty the base working file's content (in memory; call `save` to persist). */
    clear(): Future<void, unknown>
    /** Delete a config FILE (default the working file), then re-discover. */
    delete(path?: string): Future<void, unknown>
    /** Find merged entries whose dotted key or value contains `query` (case-insensitive). */
    search(query: string): Future<ConfigDef.Match[], unknown>
    /** The discovered chain (parents) with each file's `extends` locations, as a tree. */
    tree(): Future<ConfigDef.Source[], unknown>
  }

  export interface Actions extends Instance {
    /**
     * Open an INDEPENDENT config instance with its own options, discovery, merge, and working file —
     * for managing several configs at once (a second install would just overwrite this one, since
     * the plugin is a scope singleton). The instance is not stored in the scope.
     */
    open(options?: ConfigDef.Options): Future<ConfigDef.Instance, unknown>
  }
}
