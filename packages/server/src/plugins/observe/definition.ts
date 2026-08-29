import { where } from 'db:core'
import type { ObserveDef, ServerDef } from 'server:core'
import { Observe, Server, ServerErrors } from 'server:core'
import { attempt, createQueue, ensure, fork, sleep, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../../package.json'

import { ObserveErrors } from './errors'
import { instanceStats, membersView, runCluster } from './internal/cluster'
import { enqueue, flush, startFlusher } from './internal/collector'
import { mountConsole } from './internal/console'
import { DAY_MS, StateRef } from './internal/context'
import { mirror } from './internal/mirror'
import { observeService } from './internal/service'
import {
  exec,
  matchesQuery,
  openStore,
  pruneBefore,
  queryRequests,
  requestView,
} from './internal/store'
import type { ObservePluginDef } from './types'
import { requests, spans } from './utils/tables'

/**
 * The observe store: every request, span, log line, failure and event the kernel reports becomes
 * a row in the `_ob_*` tables of a private `DbClient` (over the app's adapter, or the given
 * one), written in batches off the request path. `Observe.actions.request/query/watch` read it
 * back; `console: true` serves the dev console at `/_observe`; `mirror: true` echoes to stdout.
 */
export const ObservePlugin = Observe.implement<
  ObserveDef.Options,
  [options?: ObservePluginDef.Options]
>({
  name: 'server-observe-db',
  version: pkg.version,
  description: 'Observability rows in the database',

  *setup(options) {
    const kernel = yield* Server.context.get()
    if (!kernel) {
      return yield* fail(
        ServerErrors.Configuration,
        'Observe must be installed by createServer (plugins: [ObservePlugin.use(…)])',
      )
    }
    const state: ObservePluginDef.State = {
      jobs: createQueue(),
      pending: [],
      stats: { recorded: 0, dropped: 0 },
      batch: {
        size: options?.batch?.size ?? 200,
        ms: options?.batch?.ms ?? 50,
        maxPending: options?.batch?.maxPending ?? 10_000,
      },
      retention: {
        requestsMs: options?.retention?.requestsMs ?? 7 * DAY_MS,
        logsMs: options?.retention?.logsMs ?? DAY_MS,
        everyMs: options?.retention?.everyMs ?? 10 * 60 * 1000,
      },
      mirror: options?.mirror ?? false,
      forward: options?.forward === true ? 'forward' : (options?.forward ?? false),
      fallback: options?.fallback ?? 'local',
      collect: options?.collect ?? false,
      collectorHeartbeatMs: options?.collectorHeartbeatMs ?? 5000,
      collectorSeenAt: 0,
      cluster: { forwarded: 0, received: 0, fellBack: 0 },
      flusher: null,
      wake: null,
    }
    if ((state.forward !== false || state.collect) && !kernel.carrier) {
      return yield* fail(
        ServerErrors.Configuration,
        'Observe forward/collect need a carrier (createServer installs it before plugins)',
      )
    }
    // the observe API is a REAL service (typed calls, docs, the console): registered here so
    // the edge mounts it with everything else; local only — never served over the carrier
    if (kernel.registry.services.has(observeService.name)) {
      return yield* fail(ObserveErrors.Taken, 'a service named "observe" is already declared')
    }
    ;(kernel.registry.services as Map<string, AnyType>).set(observeService.name, observeService)
    for (const [name, def] of Object.entries(observeService.actions)) {
      ;(kernel.registry.actions as Map<string, AnyType>).set(`${observeService.name}.${name}`, def)
    }
    kernel.hosted.add(observeService.name)
    yield* StateRef.set(state)
    yield* openStore(state.jobs, options?.db)
    yield* ensure(() => {
      state.jobs.close(undefined)
    })
    yield* startFlusher(state)
    if (state.forward !== false || state.collect) {
      yield* fork(() => runCluster(kernel, state))
    }
    if (state.retention.everyMs > 0) {
      yield* fork(function* () {
        for (;;) {
          yield* sleep(state.retention.everyMs)
          yield* attempt(() =>
            exec(state, db =>
              pruneBefore(db, {
                requests: Date.now() - state.retention.requestsMs,
                logs: Date.now() - state.retention.logsMs,
              }),
            ),
          )
        }
      })
    }
    const hooks: ServerDef.Hooks = {
      name: 'observe',
      *observe(event) {
        enqueue(state, event)
        if (state.mirror) {
          mirror(event)
        }
      },
      *start() {
        if (options?.console && kernel.edge) {
          yield* mountConsole(kernel.edge)
        }
      },
      *stop() {
        yield* flush(state)
      },
    }
    return { store: 'db', hooks }
  },
}).build({
  *record(event) {
    enqueue(yield* useContext(StateRef), event)
  },
  *cluster(windowMs) {
    const state = yield* useContext(StateRef)
    const kernel = yield* Server.context.expect()
    yield* flush(state)
    const since = Date.now() - (windowMs ?? 15 * 60 * 1000)
    const rows = yield* exec(state, db =>
      db
        .query(spans.name)
        .filter(
          where.and(
            where.gte('started_at', since),
            where.oneOf('kind', ['edge', 'dispatch', 'carrier']),
          ),
        )
        .collect(),
    )
    return {
      members: yield* membersView(kernel),
      instances: instanceStats(rows as AnyType),
      since,
    }
  },
  *request(requestId) {
    const state = yield* useContext(StateRef)
    yield* flush(state)
    return yield* exec(state, db => requestView(db, requestId))
  },
  *query(query) {
    const state = yield* useContext(StateRef)
    yield* flush(state)
    return yield* exec(state, db => queryRequests(db, query ?? {}))
  },
  watch: (query?: ObserveDef.Query) => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      // the delta watch runs in the store scope; rows cross back through a queue
      const out = createQueue<readonly ObserveDef.RequestRow[], never>()
      yield* exec(state, function* (db) {
        yield* fork(function* () {
          const deltas = yield* db.query(requests.name).watch({ mode: 'delta' })
          yield* deltas.next()
          for (;;) {
            const step = yield* deltas.next()
            const added = (step.value as AnyType).added as ObserveDef.RequestRow[]
            const matching = added.filter(row => matchesQuery(row, query ?? {}))
            if (matching.length > 0) {
              out.add(matching)
            }
          }
        })
      })
      return out
    },
  }),
  *prune(before) {
    const state = yield* useContext(StateRef)
    yield* flush(state)
    return yield* exec(state, db => pruneBefore(db, { requests: before, logs: before }))
  },
  *stats() {
    const state = yield* useContext(StateRef)
    return { ...state.stats, pending: state.pending.length }
  },
  *flush() {
    yield* flush(yield* useContext(StateRef))
  },
})
