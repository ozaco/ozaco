import type { CodecDef } from 'std:codec'
import type { Future, Task } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { Features } from './const'

export type ConfigDef = Plugin<ConfigDef.Context, [options?: ConfigDef.Options], ConfigDef.Actions>

export namespace ConfigDef {
  /** A codec-parsed object (config values are plain data). */
  export type Object = Record<string, unknown>

  /** A search hit: the dotted key and the value found at it in the merged config. */
  export interface Match {
    key: string
    value: unknown
  }

  /** A provenance entry: a file that defines a key and the value it holds there (`'<env>'` = overlay). */
  export interface Origin {
    path: string
    value: unknown
  }

  /** A change listener for `watch`, called with the freshly re-merged config. */
  export type Watcher = (merged: ConfigDef.Object) => void

  /** Options for `watch`. */
  export interface WatchOptions {
    /** Coalesce bursts of filesystem events into one reload; quiet-window in ms (default `50`). */
    debounce?: number | undefined
  }

  /** A discovered config file: its own data plus the sources it `extends` (lower precedence). */
  export interface Source {
    path: string
    data: ConfigDef.Object
    extends: ConfigDef.Source[]
    /** The raw `extends` spec as written in the file, re-emitted on `save` so inheritance survives. */
    extendsSpec?: string | string[] | undefined
  }

  export interface Options {
    /** Target codec (default `TomlCodec`). */
    codec?: CodecDef | undefined

    /** Config name (default `ozaco`). */
    name?: string | undefined

    /** Directory to start discovery from (default `process.cwd()`). */
    cwd?: string | undefined

    /** Active variant overlay name (`<variant>.<name>.<ext>` wins); default the `STD_CONFIG` env var. */
    variant?: string | undefined

    /** Directory to stop discovery at, inclusive (default the home dir). */
    home?: string | undefined

    /** Config dir/file should start with a dot (default `true`). */
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

    /** Discovered chain, innermost → outermost. Per dir: variant → dir files → base (`extends` resolved). */
    chain: ConfigDef.Source[]
    /** Env overlay (`ENV` feature), applied as the highest-precedence source over the chain. */
    env: ConfigDef.Object
    /** The merged view produced by the last `load` (chain merged low → high, then `env` on top). */
    merged: ConfigDef.Object
    /** The cwd base file `clear` empties and new keys from `set` land in. A live chain member once it
     * exists on disk; a standalone target (absent from `chain`/`tree`) until it is written. */
    working: ConfigDef.Source
    /** Paths of source files edited by `set`/`remove`/`clear` since the last `load`, flushed by `save`. */
    dirty: Set<string>
  }

  /** A self-contained config: its own discovery/merge/working file. The default one is `Config`'s
   * own actions; `open` mints extra, fully-independent instances. */
  export interface Instance {
    /** (Re)discover `<name>.<ext>` from cwd up to home, resolve `extends`, refresh the merged view. */
    load(cwd?: string): Future<void>
    /** Re-run discovery against the current cwd (pick up on-disk changes) without moving `cwd`. */
    refresh(): Future<void>
    /** Persist edits: no arg writes every file `set`/`remove`/`clear` touched back to its own path;
     * a `path` exports the base working file's content there instead. */
    save(path?: string): Future<void>

    /** Read a dotted key (`a.b.c`) from the merged config; omit `key` for the whole merged object. */
    get<T>(key?: string): Future<T>
    /** Set a dotted key in the file that owns it or its nearest existing ancestor path (else the base
     * working file); reflected in the merge at once, `save` to persist. */
    set(key: string, value: unknown): Future<void>
    /** Remove a dotted key from the file that currently provides it (in memory; call `save` to persist). */
    remove(key: string): Future<void>
    /** Empty the base working file's content (in memory; call `save` to persist). */
    clear(): Future<void>
    /** Delete a config FILE (default the working file), then re-discover. */
    delete(path?: string): Future<void>
    /** Find merged entries whose dotted key or value contains `query` (case-insensitive). */
    search(query: string): Future<ConfigDef.Match[]>
    /** The discovered chain (files that exist on disk) with each file's resolved `extends`. */
    tree(): Future<ConfigDef.Source[]>

    /** Whether the merged config has a value at the dotted `key`. */
    has(key: string): Future<boolean>
    /** All leaf dotted keys present in the merged config. */
    keys(): Future<string[]>
    /** The path of the highest-precedence file that provides `key` (`'<env>'` for the env overlay). */
    origin(key: string): Future<string | undefined>
    /** Every file that defines `key`, highest → lowest precedence, with the value each holds there. */
    explain(key: string): Future<ConfigDef.Origin[]>
    /** Watch the config sources and re-merge on change, invoking `listener` when the merged view
     * actually changes. A config directory (`DIR` feature) is watched recursively; every other
     * source file is watched individually; events are debounced. Returns the background task —
     * `halt()` it to stop watching. */
    watch(listener: ConfigDef.Watcher, options?: ConfigDef.WatchOptions): Future<Task<void>>
  }

  export interface Actions extends Instance {
    /**
     * Open an INDEPENDENT config instance with its own options, discovery, merge, and working file —
     * for managing several configs at once (a second install would just overwrite this one, since
     * the plugin is a scope singleton). The instance is not stored in the scope.
     */
    open(options?: ConfigDef.Options): Future<ConfigDef.Instance>
  }
}
