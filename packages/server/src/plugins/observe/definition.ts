import type { ObserveDef, ServerDef } from 'server:core'
import { Observe, Server, ServerErrors } from 'server:core'
import { attempt, createQueue, ensure, fork, sleep, useContext } from 'std:effect'
import { fail } from 'std:result'
import { Trace } from 'std:trace'

import pkg from '../../../package.json'

import { instanceStats, membersView, runCluster } from './internal/cluster'
import { enqueue, flush, startFlusher } from './internal/collector'
import { mountConsole } from './internal/console'
import { DAY_MS, StateRef } from './internal/context'
import { OBSERVE_SERVICE, observeServiceOf } from './internal/service'
import {
  clusterSpans,
  exec,
  matchesQuery,
  openStore,
  pruneBefore,
  queryTraces,
  requestView,
  traceView,
} from './internal/store'
import type { ObservePluginDef } from './types/observe'

const CAPTURE_KEYS = ['headers', 'bodies', 'frames', 'enduser'] as const

/** `capture` is the server's ONE capture switch (`createServer({ observe: { capture } })`): a key
 * given here overrides it for every sink. */
const applyCapture = (
  kernel: ServerDef.Context,
  capture: ServerDef.CaptureOptions | undefined,
): void => {
  for (const key of CAPTURE_KEYS) {
    const value = capture?.[key]

    if (value !== undefined) {
      kernel.telemetry.observe.capture[key] = value
    }
  }

  if (capture?.sensitiveKeys) {
    kernel.telemetry.observe.capture.sensitiveKeys = Object.freeze([...capture.sensitiveKeys])
  }
}

const stateOf = (options: ObservePluginDef.Options | undefined): ObservePluginDef.State => ({
  pending: [],
  stats: { recorded: 0, dropped: 0 },
  batch: {
    size: options?.batch?.size ?? 200,
    waitMs: options?.batch?.waitMs ?? 50,
    maxPending: options?.batch?.maxPending ?? 10_000,
  },
  retention: {
    spansMs: options?.retention?.spansMs ?? 7 * DAY_MS,
    logsMs: options?.retention?.logsMs ?? DAY_MS,
    pruneEveryMs: options?.retention?.pruneEveryMs ?? 10 * 60 * 1000,
  },
  forward:
    options?.cluster?.sendToCollector === true
      ? 'forward'
      : options?.cluster?.sendToCollector === 'and-local'
        ? 'both'
        : false,
  fallback: options?.cluster?.whenCollectorDown ?? 'local',
  collect: options?.cluster?.isCollector ?? false,
  collectorHeartbeatMs: options?.cluster?.heartbeatMs ?? 5000,
  collectorSeenAt: 0,
  cluster: { forwarded: 0, received: 0, fellBack: 0 },
  watchers: new Set(),
  store: null,
  flusher: null,
  wake: null,
})

/**
 * The observe store: every finished span and log record the kernel reports — exactly what every
 * exporter ships — becomes one row of the `_ob2_spans` / `_ob2_logs` tables of a private
 * `DbClient` (over the app's adapter, or the given one), with its resource, written in batches
 * off the request path. `Observe.actions.traces/trace/request/watch` read it back over the
 * `observe` service (`/_observe/api/*` — `auth` gates it like any action's requirement);
 * `console: true` serves the dev console at `/_observe` (a public static shell: its data rides
 * that API). The store's own work is never telemetry. Shipping elsewhere is an
 * `ObserveExporter`'s job (`StdoutExporter`, `OtlpExporter`, `OpenObserveExporter`).
 */
export const ObservePlugin = Observe.implement<
  ObserveDef.Options,
  [options?: ObservePluginDef.Options]
>({
  name: 'server-observe-db',
  version: pkg.version,
  description: 'Spans and log records in the database',

  *setup(options) {
    const kernel = yield* Server.context.get()

    if (!kernel) {
      return yield* fail(
        ServerErrors.Configuration,
        'Observe must be installed by createServer (plugins: [ObservePlugin.use(…)])',
      )
    }

    const state = stateOf(options)

    if ((state.forward !== false || state.collect) && !kernel.carrier) {
      return yield* fail(
        ServerErrors.Configuration,
        'Observe cluster mode needs a carrier (createServer installs it before plugins)',
      )
    }

    applyCapture(kernel, options?.capture)

    const selfTrace = options?.selfTrace === true

    if (selfTrace) {
      kernel.selfTraced.add(OBSERVE_SERVICE)
      yield* ensure(() => {
        kernel.selfTraced.delete(OBSERVE_SERVICE)
      })
    }

    yield* StateRef.set(state)
    yield* openStore(state, options?.db)
    yield* startFlusher(state)

    if (state.forward !== false || state.collect) {
      yield* fork(() => runCluster(kernel, state))
    }

    if (state.retention.pruneEveryMs > 0) {
      yield* fork(() =>
        Trace.actions.suppressed(function* () {
          for (;;) {
            yield* sleep(state.retention.pruneEveryMs)

            const now = Date.now()

            yield* attempt(() =>
              exec(state, db =>
                pruneBefore(db, {
                  spans: now - state.retention.spansMs,
                  logs: now - state.retention.logsMs,
                }),
              ),
            )
          }
        }),
      )
    }

    const hooks: ServerDef.Hooks = {
      name: 'observe',
      *observe(event) {
        enqueue(state, event)
      },
      *start() {
        if (options?.console && kernel.edge) {
          yield* mountConsole(kernel.edge, selfTrace)
        }
      },
      *stop() {
        yield* flush(state)
      },
    }

    // the observe API is a REAL service (typed calls, docs, the console): `createServer`
    // registers it through the PluginContext seam — mounted with everything else, hosted
    // locally, never served over the carrier. `auth` is its requirement (the service-level
    // option: an action option like any other — the `Auth` plugin must handle it)
    return { store: 'db', hooks, services: [observeServiceOf(options?.auth)] }
  },
}).build({
  *record(event) {
    enqueue(yield* useContext(StateRef), event)
  },
  *traces(query) {
    const state = yield* useContext(StateRef)

    yield* flush(state)

    return yield* exec(state, db => queryTraces(db, query ?? {}))
  },
  *trace(traceId) {
    const state = yield* useContext(StateRef)

    yield* flush(state)

    return yield* exec(state, db => traceView(db, traceId))
  },
  *request(id) {
    const state = yield* useContext(StateRef)

    yield* flush(state)

    return yield* exec(state, db => requestView(db, id))
  },
  watch: (query?: ObserveDef.TracesQuery) => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      // the writer hands every stored batch's root rows to the watchers; this one lives as long
      // as the scope that subscribed (an SSE stream ends → it is gone)
      const out = createQueue<readonly ObserveDef.SpanRow[], never>()
      const watcher: ObservePluginDef.Watcher = rows => {
        const matching = rows.filter(row => matchesQuery(row, query ?? {}))

        if (matching.length > 0) {
          out.add(matching)
        }
      }

      state.watchers.add(watcher)
      yield* ensure(() => {
        state.watchers.delete(watcher)
      })

      return out
    },
  }),
  *prune(before) {
    const state = yield* useContext(StateRef)

    yield* flush(state)

    return yield* exec(state, db => pruneBefore(db, { spans: before, logs: before }))
  },
  *stats() {
    const state = yield* useContext(StateRef)

    return { ...state.stats, pending: state.pending.length, ...state.cluster }
  },
  *cluster(windowMs) {
    const state = yield* useContext(StateRef)
    const kernel = yield* Server.context.expect()

    yield* flush(state)

    const since = Date.now() - (windowMs ?? 15 * 60 * 1000)
    const rows = yield* exec(state, db => clusterSpans(db, since))

    return {
      members: yield* membersView(kernel),
      instances: instanceStats(rows),
      since,
    }
  },
  *flush() {
    yield* flush(yield* useContext(StateRef))
  },
})
