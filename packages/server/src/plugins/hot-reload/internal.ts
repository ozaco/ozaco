// oxlint-disable import/exports-last
import type { ServerDef, ServiceDef } from 'server:core'
import { ServerErrors, statusOf as failureStatus, tagOf } from 'server:core'
import { isService, scopeOf } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, createSignal, debounce, each, fork, until } from 'std:effect'
import { IO } from 'std:io'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { asFailure, fail, formatFailure, isFailure } from 'std:result'
import { fromBase64, toBase64 } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { current, span, TraceSeverity } from 'std:trace'

import { HotReloadErrors } from './errors'
import type { HotReloadDef } from './types'

export const DEFAULT_DEBOUNCE_MS = 80

/** The `logger` binding of every HotReload line — the record's instrumentation scope. */
const LOGGER = '@ozaco/server/hot-reload'

/** The instrumentation scope of every HotReload span (`@ozaco/server/hot-reload`). */
const SCOPE = scopeOf('hot-reload')

/** The most changed paths one generation's span names (`ozaco.reload.triggers`). */
const MAX_TRIGGERS = 32

/** How a HotReload span classifies a failure escaping it: the server's status table (an
 * unmapped tag — a broken save — is a 500: the span fails) and its tags (`tagOf`). */
const FAILURE: TraceDef.FailureOptions = {
  status: failure => failureStatus(failure),
  type: tagOf,
}

/** A child step of one generation (`hot-reload.bundle`, `hot-reload.import`, `server.reload`). */
const step = <T>(name: string, body: () => Operation<T>): Operation<T> =>
  span(name, { kind: 'internal', scope: SCOPE, failure: FAILURE }, () => body())

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
    triggers: new Set(),
    previous: null,
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
const INLINE_MAP = /(\/\/# sourceMappingURL=data:application\/json;base64,)([A-Za-z0-9+/=]+)(\s*)$/u

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
 * Bun writes an inline source map's `sources` relative to the process working directory — the
 * bundle runs from a temp file, so a stack frame of the user's module (a TypeError while it
 * evaluates) would point into the temp directory. Pin them to absolute paths: the frames name the
 * user's own files. A map it cannot read is left as it is.
 */
const pinSourceMap = (text: string, base: string): string => {
  const match = INLINE_MAP.exec(text)

  if (!match) {
    return text
  }

  try {
    const map = JSON.parse(new TextDecoder().decode(fromBase64(match[2]!))) as {
      sources?: unknown
    }

    if (!Array.isArray(map.sources)) {
      return text
    }

    map.sources = map.sources.map(source =>
      typeof source === 'string' && !source.startsWith('/') && !source.includes(':')
        ? `${base}/${source}`
        : source,
    )

    const encoded = toBase64(new TextEncoder().encode(JSON.stringify(map)))
    return `${text.slice(0, match.index)}${match[1]}${encoded}${match[3]}`
  } catch {
    return text
  }
}

/** A bundler message (`BuildMessage` / `ResolveMessage`) as a failure — `HotReloadErrors.Build`,
 * its text the message — its source position (`file:line:column`) as its cause. */
const buildFailureOf = (log: unknown): Result.Failure<unknown> => {
  const at = (log as { position?: { file?: string; line?: number; column?: number } | null })
    .position
  const position = at?.file ? `${at.file}:${at.line ?? 0}:${at.column ?? 0}` : null

  return asFailure(log, HotReloadErrors, position)
}

/** What a failed build said: every error-level bundler message (all of them when none is) as a
 * failure of its own. */
const buildFailuresOf = (logs: readonly unknown[]): Result.Failure<unknown>[] => {
  const entries = logs.filter(log => typeof log === 'object' && log !== null)
  const errors = entries.filter(log => (log as { level?: unknown }).level === 'error')

  return (errors.length > 0 ? errors : entries).map(buildFailureOf)
}

/**
 * Bun: bundle the entry with EVERY module under the roots into one fresh file — the change in
 * any of them reaches the node — while imports that resolve outside the roots stay external,
 * pinned to the absolute path the app already loaded (the same `@ozaco/*` instances, the same
 * protocol singletons). Promise-land on purpose (`Bun.build` is), settled as a value — a failed
 * build keeps what the bundler said as `failures` (one per message, at its source position; a
 * throw of `Bun.build` itself folded) — the load failure's nested causes.
 */
const bundleWithBun = async (
  state: HotReloadDef.State,
): Promise<
  { readonly text: string } | { readonly failures: readonly Result.Failure<unknown>[] }
> => {
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
      return { failures: buildFailuresOf(result.logs) }
    }

    return { text: pinSourceMap(await result.outputs[0].text(), cwd().replace(/\/+$/u, '')) }
  } catch (error) {
    return { failures: [asFailure(error, HotReloadErrors)] }
  }
}

/** What to `import()` for THIS generation: on Bun a freshly bundled temp file (its directory
 * dropped right after it loaded — the bundle runs in its `hot-reload.bundle` span); elsewhere the
 * entry itself under a new query string — its imports stay cached there, so only a change in the
 * entry reaches the node. */
function* freshSpecifier(
  state: HotReloadDef.State,
): Operation<{ readonly specifier: string; readonly cleanup: string | null }> {
  if (typeof Bun === 'undefined' || typeof Bun.build !== 'function') {
    return { specifier: `${fileUrl(state.entry)}?hot=${state.generation}`, cleanup: null }
  }

  const text = yield* step('hot-reload.bundle', function* () {
    const bundled = yield* until(bundleWithBun(state))

    if ('failures' in bundled) {
      return yield* fail(
        HotReloadErrors.Load,
        `could not bundle ${state.entry}`,
        ...bundled.failures,
      )
    }

    return bundled.text
  })

  // a directory of its own per generation: Bun's resolver caches a directory's entries once
  // it looked one up, so a second file in the same directory would be "not found"
  const dir = yield* IO.actions.join(
    yield* IO.actions.tmpdir(),
    'ozaco-hot-reload',
    yield* IO.actions.ulid(),
  )
  yield* IO.actions.ensureDir(dir)
  const file = yield* IO.actions.join(dir, `services-${state.generation}.mjs`)
  yield* IO.actions.write(file, text)

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

/** `import()` the fresh specifier and read its services — a module that throws while it
 * evaluates keeps what it threw (its fold, the thrown value as `raw`; a thrown Failure whole) as
 * the cause, one level under the load failure. */
function* evaluate(
  state: HotReloadDef.State,
  specifier: string,
): Operation<readonly ServiceDef.Service[]> {
  const module = yield* attempt(() => until(import(specifier) as Promise<Record<string, unknown>>))

  if (isFailure(module)) {
    return yield* fail(HotReloadErrors.Load, `could not evaluate ${state.entry}`, module)
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

/** Evaluate the entry afresh and read its services (`hot-reload.bundle` on Bun, then
 * `hot-reload.import` — the custom `load` runs there too). */
export function* loadEntry(state: HotReloadDef.State): Operation<readonly ServiceDef.Service[]> {
  const load = state.options.load

  if (load) {
    return yield* step('hot-reload.import', () => load())
  }

  const fresh = yield* freshSpecifier(state)
  const services = yield* attempt(() =>
    step('hot-reload.import', () => evaluate(state, fresh.specifier)),
  )

  if (fresh.cleanup) {
    yield* attempt(() => IO.actions.rm(fresh.cleanup!, { recursive: true, force: true }))
  }

  return isFailure(services) ? yield* services : services.value
}

/** The console line of a HotReload message: the data (a failure under `error` rendered as its
 * whole chain on the lines below). */
const consoleArgs = (data: Readonly<Record<string, unknown>> | undefined): unknown[] => {
  if (!data) {
    return []
  }

  const { error, ...rest } = data
  const args: unknown[] = Object.keys(rest).length > 0 ? [rest] : []

  if (isFailure(error)) {
    args.push(`\n${formatFailure(error, { chain: true })}`)
  } else if (error !== undefined) {
    args.push(error)
  }

  return args
}

/**
 * A line to whoever listens: the installed `Logger` — under the binding `logger:
 * '@ozaco/server/hot-reload'` (the record's scope), a failure passed AS the Failure under
 * `error` (the Logger renders its chain; inside a recording span it is recorded once) — else the
 * console (this is a dev tool). Never fails the reload.
 */
export function* say(
  level: 'info' | 'warn',
  message: string,
  data?: Readonly<Record<string, unknown>>,
): Operation<void> {
  if (yield* Logger.context.get()) {
    yield* attempt(() =>
      Logger.actions.child({ logger: LOGGER }, () =>
        data === undefined
          ? Logger.actions[level](message)
          : Logger.actions[level](message, { ...data }),
      ),
    )
    return
  }

  console[level](`[hot-reload] ${message}`, ...consoleArgs(data))
}

/** A failure the reload survives (it failed and the node keeps serving, a user hook failed): the
 * Logger line carrying the Failure itself, and the WARN exception on the active span — recorded
 * here, once, with or without a Logger. The line goes first: the Logger prints the failure once
 * (the server never forwards the record of a failure a line printed) and its bridge records it;
 * the explicit record is then a no-op, kept for a Logger that drops the line or has no bridge. */
function* complain(
  message: string,
  failure: Result.Failure<unknown>,
  data?: Readonly<Record<string, unknown>>,
): Operation<void> {
  yield* say('warn', message, { ...data, error: failure })
  yield* (yield* current()).recordFailure(failure, { severity: TraceSeverity.warn })
}

/** A user hook (`onReload` / `onError`): its failure is logged, never swallowed, never raised
 * into the reload. */
function* runHook(name: string, hook: () => Operation<void>): Operation<void> {
  const outcome = yield* attempt(hook)

  if (isFailure(outcome)) {
    yield* complain(`the ${name} hook failed`, outcome)
  }
}

/** The changed paths the next generation takes (the watcher notes at most `MAX_TRIGGERS`). */
const noteTrigger = (state: HotReloadDef.State, path: string): void => {
  if (state.triggers.size < MAX_TRIGGERS) {
    state.triggers.add(path)
  }
}

/** One generation inside its root span: load (`hot-reload.bundle` / `hot-reload.import`), swap
 * (`server.reload`), tell — a failure is recorded (WARN: the node keeps serving), logged and
 * handed to `onError`, then raised; a success lands on the span as what changed. */
function* generation(
  state: HotReloadDef.State,
  swap: (services: readonly ServiceDef.Service[]) => Operation<ServerDef.ReloadReport>,
  handle: TraceDef.SpanHandle,
): Operation<ServerDef.ReloadReport> {
  const at = state.generation
  const startedAt = Date.now()
  const outcome = yield* attempt(function* () {
    const services = yield* loadEntry(state)
    return yield* step('server.reload', () => swap(services))
  })

  if (isFailure(outcome)) {
    state.lastError = formatFailure(outcome)
    yield* complain(`reload #${at} failed — still serving the previous declarations`, outcome, {
      'ozaco.reload.generation': at,
    })

    const onError = state.options.onError

    if (onError) {
      yield* runHook('onError', () => onError(outcome))
    }

    return yield* outcome
  }

  const report = outcome.value
  // an empty list is left out — a sink that drops empty arrays (OpenObserve) would otherwise
  // hold other data than the rest
  const changed = Object.fromEntries(
    (['added', 'removed', 'replaced'] as const)
      .filter(kind => report[kind].length > 0)
      .map(kind => [`ozaco.reload.services.${kind}`, report[kind]]),
  )

  handle.setAttributes(changed)
  state.lastError = null
  state.lastReloadAt = Date.now()
  yield* say('info', `reload #${at} in ${state.lastReloadAt - startedAt}ms`, {
    'ozaco.reload.generation': at,
    ...changed,
    'ozaco.reload.actions': report.actions,
    'ozaco.reload.sockets': report.sockets,
  })

  const onReload = state.options.onReload

  if (onReload) {
    yield* runHook('onReload', () => onReload(report))
  }

  return report
}

/**
 * One reload, a generation: its own ROOT span `hot-reload` (`ozaco.reload.generation`, the
 * changed paths as `ozaco.reload.triggers`, what changed as `ozaco.reload.services.*`) LINKING
 * the previous generation (`reload.previous`). A failure keeps the running declarations and is
 * told — raised to the caller (the manual `reload()` action), never through the watcher.
 */
export function* reloadOnce(
  state: HotReloadDef.State,
  swap: (services: readonly ServiceDef.Service[]) => Operation<ServerDef.ReloadReport>,
): Operation<ServerDef.ReloadReport> {
  state.generation += 1
  const triggers = [...state.triggers]
  state.triggers.clear()
  const previous = state.previous

  return yield* span(
    'hot-reload',
    {
      kind: 'internal',
      scope: SCOPE,
      parent: null,
      links: previous
        ? [{ context: previous, attributes: { 'ozaco.link.reason': 'reload.previous' } }]
        : [],
      attributes: {
        'ozaco.reload.generation': state.generation,
        'ozaco.reload.triggers': triggers.length > 0 ? triggers : undefined,
      },
      failure: FAILURE,
    },
    function* (handle) {
      if (handle.recording) {
        state.previous = handle.context
      }

      return yield* generation(state, swap, handle)
    },
  )
}

/**
 * Watch every root; a burst of events under them (that no `ignore` pattern matches) becomes
 * one `reload` after `debounceMs` of quiet — the changed paths are that generation's
 * `ozaco.reload.triggers`. Runs until its scope ends.
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
          noteTrigger(state, path)
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
