// oxlint-disable import/exports-last
import type { ServerDef, ServiceDef } from 'server:core'
import { ServerErrors } from 'server:core'
import { isService } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, createSignal, debounce, each, fork, until } from 'std:effect'
import { IO } from 'std:io'
import { Logger } from 'std:logger'
import { fail, isFailure } from 'std:result'

import { HotReloadErrors } from './errors'
import type { HotReloadDef } from './types'

export const DEFAULT_DEBOUNCE_MS = 80

export const DEFAULT_IGNORE: readonly RegExp[] = [
  /\/node_modules\//u,
  /\/\.git\//u,
  /\/dist\//u,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
]

const cwd = (): string =>
  (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/'

/** An absolute path without a trailing separator. */
function* absolute(path: string): Operation<string> {
  const full = (yield* IO.actions.isAbsolute(path)) ? path : yield* IO.actions.join(cwd(), path)
  return full.length > 1 ? full.replace(/\/+$/u, '') : full
}

export function* createState(options: HotReloadDef.Options): Operation<HotReloadDef.State> {
  const entry = yield* absolute(options.entry)
  const roots: string[] = []

  for (const path of options.watch ?? [yield* IO.actions.dirname(entry)]) {
    roots.push(yield* absolute(path))
  }

  return {
    entry,
    exportName: options.export ?? 'services',
    roots,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    ignore: options.ignore ?? DEFAULT_IGNORE,
    options,
    generation: 0,
    watching: false,
    lastReloadAt: null,
    lastError: null,
  }
}

export const statusOf = (state: HotReloadDef.State): HotReloadDef.Status => ({
  entry: state.entry,
  watch: state.roots,
  generation: state.generation,
  watching: state.watching,
  lastReloadAt: state.lastReloadAt,
  lastError: state.lastError,
})

const under = (path: string, roots: readonly string[]): boolean =>
  roots.some(root => path === root || path.startsWith(`${root}/`))

const ignored = (path: string, ignore: readonly RegExp[]): boolean =>
  ignore.some(pattern => pattern.test(path))

const fileUrl = (path: string): string => (path.startsWith('/') ? `file://${path}` : path)

/** `Bun.resolveSync` from the importer's directory; `null` when the runtime cannot (a builtin,
 * a missing package) — such an import stays as written. */
const resolveFrom = (specifier: string, importer: string): string | null => {
  try {
    const at = importer.lastIndexOf('/')
    return Bun.resolveSync(specifier, at > 0 ? importer.slice(0, at) : cwd())
  } catch {
    return null
  }
}

const LOADER_OF: Readonly<Record<string, 'ts' | 'tsx' | 'js' | 'jsx'>> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
}

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/u
const IMPORT_META = /\bimport\.meta\.(url|dirname|dir|filename|file|path)\b/gu

/**
 * A bundled module evaluates from the temp file, so its `import.meta` would point THERE — a
 * handler that reads a sibling file (`new URL('../page.html', import.meta.url)`) would look in
 * the wrong place. Pin every `import.meta.{url,dir,dirname,file,filename,path}` of a bundled
 * module to the module's own location before it is bundled.
 */
export const pinImportMeta = (source: string, path: string): string => {
  const at = path.lastIndexOf('/')
  const dir = at > 0 ? path.slice(0, at) : '/'
  const file = path.slice(at + 1)
  const values: Readonly<Record<string, string>> = {
    url: fileUrl(path),
    dir,
    dirname: dir,
    file,
    filename: path,
    path,
  }

  return source.replace(IMPORT_META, (_match, key: string) => JSON.stringify(values[key]))
}

/**
 * Bun: bundle the entry with EVERY module under the roots into one fresh file — the change in
 * any of them reaches the node — while imports that resolve outside the roots stay external,
 * pinned to the absolute path the app already loaded (the same `@ozaco/*` instances, the same
 * protocol singletons). Promise-land on purpose (`Bun.build` is), settled as a value.
 */
const bundleWithBun = async (
  state: HotReloadDef.State,
): Promise<{ readonly text: string } | { readonly error: string }> => {
  try {
    const result = await Bun.build({
      entrypoints: [state.entry],
      target: 'bun',
      format: 'esm',
      sourcemap: 'inline',
      throw: false,

      plugins: [
        {
          name: 'ozaco-hot-reload',
          setup(build) {
            build.onResolve({ filter: /.*/u }, args => {
              // the entry itself has no importer; everything it pulls in is decided here
              if (!args.importer) {
                return undefined
              }

              const resolved = resolveFrom(args.path, args.importer)

              if (resolved && under(resolved, state.roots) && !ignored(resolved, state.ignore)) {
                return { path: resolved }
              }

              return { path: resolved ?? args.path, external: true }
            })

            // only bundled (in-root) modules are loaded; externals never reach here
            build.onLoad({ filter: SOURCE_EXT }, async args => {
              const at = args.path.lastIndexOf('.')
              const loader = LOADER_OF[args.path.slice(at)] ?? 'ts'
              const source = await Bun.file(args.path).text()

              return { contents: pinImportMeta(source, args.path), loader }
            })
          },
        },
      ],
    })

    if (!result.success || !result.outputs[0]) {
      return { error: result.logs.map(log => String(log.message ?? log)).join('; ') }
    }

    return { text: await result.outputs[0].text() }
  } catch (error) {
    return {
      error: error instanceof AggregateError ? error.errors.map(String).join('; ') : String(error),
    }
  }
}

/** What to `import()` for THIS generation: on Bun a freshly bundled temp file (its directory
 * dropped right after it loaded); elsewhere the entry itself under a new query string — its imports stay
 * cached there, so only a change in the entry reaches the node. */
function* freshSpecifier(
  state: HotReloadDef.State,
): Operation<{ readonly specifier: string; readonly cleanup: string | null }> {
  if (typeof Bun === 'undefined' || typeof Bun.build !== 'function') {
    return { specifier: `${fileUrl(state.entry)}?hot=${state.generation}`, cleanup: null }
  }

  const bundled = yield* until(bundleWithBun(state))

  if ('error' in bundled) {
    return yield* fail(HotReloadErrors.Load, `could not bundle ${state.entry}: ${bundled.error}`)
  }

  // a directory of its own per generation: Bun's resolver caches a directory's entries once
  // it looked one up, so a second file in the same directory would be "not found"
  const dir = yield* IO.actions.join(
    yield* IO.actions.tmpdir(),
    'ozaco-hot-reload',
    yield* IO.actions.ulid(),
  )
  yield* IO.actions.ensureDir(dir)
  const file = yield* IO.actions.join(dir, `services-${state.generation}.mjs`)
  yield* IO.actions.write(file, bundled.text)

  return { specifier: fileUrl(file), cleanup: dir }
}

/** The declarations of the entry module: `export const services = [...]` (or the default
 * export) — anything else is a configuration failure, not a silent empty node. */
const servicesOf = (
  module: Record<string, unknown>,
  state: HotReloadDef.State,
): ServiceDef.Service[] | null => {
  const value = state.exportName in module ? module[state.exportName] : module['default']

  if (!Array.isArray(value) || !value.every(isService)) {
    return null
  }

  return value as ServiceDef.Service[]
}

/** Evaluate the entry afresh and read its services. */
export function* loadEntry(state: HotReloadDef.State): Operation<readonly ServiceDef.Service[]> {
  if (state.options.load) {
    return yield* state.options.load()
  }

  const fresh = yield* freshSpecifier(state)
  const module = yield* attempt(
    () => until(import(fresh.specifier) as Promise<Record<string, unknown>>),
    'hot-reload:import',
  )

  if (fresh.cleanup) {
    yield* attempt(() => IO.actions.rm(fresh.cleanup!, { recursive: true, force: true }))
  }

  if (isFailure(module)) {
    return yield* fail(
      HotReloadErrors.Load,
      `could not evaluate ${state.entry}: ${String(module.error)}`,
      ...module.causes,
    )
  }

  const services = servicesOf(module.value, state)

  if (!services) {
    return yield* fail(
      ServerErrors.Configuration,
      `${state.entry} must export "${state.exportName}" (or a default export) as an array of service() declarations`,
    )
  }

  return services
}

/** A line to whoever listens: the installed `Logger`, else the console (this is a dev tool). */
export function* say(
  level: 'info' | 'warn',
  message: string,
  data?: Record<string, unknown>,
): Operation<void> {
  if (yield* Logger.context.get()) {
    yield* Logger.actions[level](message, data)
    return
  }

  console[level](`[hot-reload] ${message}`, ...(data ? [data] : []))
}

/** One reload: load, swap, report — a failure keeps the running declarations and is told, never
 * raised through the watcher. Resolves the report (the manual `reload()` action re-raises). */
export function* reloadOnce(
  state: HotReloadDef.State,
  swap: (services: readonly ServiceDef.Service[]) => Operation<ServerDef.ReloadReport>,
): Operation<ServerDef.ReloadReport> {
  state.generation += 1
  const startedAt = Date.now()
  const outcome = yield* attempt(function* () {
    const services = yield* loadEntry(state)
    return yield* swap(services)
  })

  if (isFailure(outcome)) {
    state.lastError = `${String(outcome.error)}: ${outcome.message}`
    yield* say(
      'warn',
      `reload #${state.generation} failed — still serving the previous declarations`,
      {
        error: outcome.error,
        message: outcome.message,
        causes: outcome.causes,
      },
    )

    if (state.options.onError) {
      yield* attempt(() => state.options.onError!(outcome))
    }

    return yield* outcome
  }

  const report = outcome.value
  state.lastError = null
  state.lastReloadAt = Date.now()
  yield* say('info', `reload #${state.generation} in ${state.lastReloadAt - startedAt}ms`, {
    added: report.added,
    removed: report.removed,
    replaced: report.replaced,
    actions: report.actions,
    sockets: report.sockets,
  })

  if (state.options.onReload) {
    yield* attempt(() => state.options.onReload!(report))
  }

  return report
}

/**
 * Watch every root; a burst of events under them (that no `ignore` pattern matches) becomes
 * one `reload` after `debounceMs` of quiet. Runs until its scope ends.
 */
export function* watchRoots(
  state: HotReloadDef.State,
  reload: () => Operation<unknown>,
): Operation<void> {
  const bump = createSignal<string, never>()

  const feed = (root: string) =>
    function* () {
      for (const event of yield* each(IO.actions.watch(root, { recursive: true }))) {
        const path = event.path ? yield* IO.actions.join(root, event.path) : root

        if (!ignored(path, state.ignore)) {
          bump.send(path)
        }

        yield* each.next()
      }
    }

  state.watching = true

  for (const root of state.roots) {
    yield* fork(feed(root))
  }

  for (const _ of yield* each(debounce(bump, state.debounceMs))) {
    yield* attempt(reload)
    yield* each.next()
  }
}
