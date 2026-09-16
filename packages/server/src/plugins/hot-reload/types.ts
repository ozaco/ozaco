import type { ServerDef, ServiceDef } from 'server:core'
import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

export namespace HotReloadDef {
  export interface Options {
    /** The module exporting the service declarations — absolute, or relative to the process
     * working directory. */
    readonly entry: string

    /** The export holding the `Service[]`. Default `'services'`; the default export when that
     * name is absent. */
    readonly export?: string | undefined

    /** Files or directories to watch (directories recursively). Default: the entry's
     * directory. On Bun every module under these paths is re-evaluated on a reload; other
     * runtimes re-evaluate the entry alone (its imports stay cached). */
    readonly watch?: readonly string[] | undefined

    /** A burst of file events (one save fires several) collapses into one reload. Default 80. */
    readonly debounceMs?: number | undefined

    /** Paths that never trigger a reload nor get re-evaluated. Default: `node_modules`, `.git`,
     * `dist`, test files. */
    readonly ignore?: readonly RegExp[] | undefined

    /** Produce the services yourself instead of importing `entry` (a bundler, a registry, a
     * test). The watcher still drives WHEN. */
    readonly load?: (() => Operation<readonly ServiceDef.Service[]>) | undefined

    /** Called after every successful reload with what changed. */
    readonly onReload?: ((report: ServerDef.ReloadReport) => Operation<void>) | undefined

    /** Called when a reload fails (a syntax error, a duplicate service, an unknown option);
     * the previous declarations keep serving. */
    readonly onError?: ((failure: Result.Failure<unknown>) => Operation<void>) | undefined
  }

  export interface Status {
    readonly entry: string
    readonly watch: readonly string[]

    /** how many reloads were attempted (`0` = the boot declarations). */
    readonly generation: number
    readonly watching: boolean
    readonly lastReloadAt: number | null
    readonly lastError: string | null
  }

  export interface State {
    readonly entry: string
    readonly exportName: string
    readonly roots: readonly string[]
    readonly debounceMs: number
    readonly ignore: readonly RegExp[]
    readonly options: Options
    generation: number
    watching: boolean
    lastReloadAt: number | null
    lastError: string | null
  }

  export interface Context extends ServerDef.PluginContext {
    reload(): Operation<ServerDef.ReloadReport>
    status(): Status
  }

  export interface Actions {
    /** Load the declarations and swap them in now — what the watcher does on a change. */
    reload(): Operation<ServerDef.ReloadReport>
    status(): Operation<Status>
  }
}
