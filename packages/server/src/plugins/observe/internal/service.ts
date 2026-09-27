import type { OptionsDef } from 'server:core'
import { action, Observe, Server, service, STATUS_OF, stream } from 'server:core'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import pkg from '../../../../package.json'
import { serviceDocOf } from '../../docs/internal/manifest'
import { ObserveErrors } from '../errors'

/** Rows come straight from the store: assert the keys, pass the rest through. */
const spanRow = z.looseObject({ trace_id: z.string(), span_id: z.string() })
const logRow = z.looseObject({ time: z.number(), body: z.string() })

const page = z.object({
  traces: z.array(spanRow),
  cursor: z.string().nullable(),
})

const view = z.object({
  trace_id: z.string(),
  spans: z.array(spanRow),
  logs: z.array(logRow),
})

const query = z.object({
  name: z.string().optional(),
  route: z.string().optional(),
  service: z.string().optional(),
  status: z.enum(['ok', 'failed', 'error']).optional(),
  errorType: z.string().optional(),
  slowerThan: z.number().optional(),
  since: z.number().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
})

/** The observe service's name — what the plugin registers (and `selfTrace` names). */
export const OBSERVE_SERVICE = 'observe'

/**
 * The observe API as a REAL service: the console (and any `@ozaco/client`) reaches the store
 * through the manifest — typed, documented, SSE for the live feed. Mounted under
 * `/_observe/api/*`; registered by the plugin on every node it is installed on (local only,
 * never served over the carrier). A plugin service: recorded only when a call fails, unless
 * `ObservePlugin.use({ selfTrace: true })`. `auth` (`ObservePlugin.use({ auth })`) is the
 * requirement of every action — the service-level `auth` option; none given, they fall under
 * `Auth`'s `default` like any action.
 */
export const observeServiceOf = (auth?: OptionsDef.Requirement) =>
  service(
    OBSERVE_SERVICE,
    {
      traces: action.query(
        {
          input: query,
          output: page,
          route: { method: 'GET', path: '/_observe/api/traces' },
          description: 'Root spans — one per trace, newest first, cursor-paged',
        },
        function* ({ input }) {
          return (yield* Observe.actions.traces(input)) as AnyType
        },
      ),
      trace: action.query(
        {
          input: z.object({ id: z.string() }),
          output: view,
          route: { method: 'GET', path: '/_observe/api/trace/:id' },
          errors: { 'observe.not-found': 404 },
          description: 'One trace: every span and log record of it',
        },
        function* ({ input }) {
          const found = yield* Observe.actions.trace(input.id)

          if (!found) {
            return yield* fail(ObserveErrors.NotFound, `no trace ${input.id}`)
          }

          return found as AnyType
        },
      ),
      request: action.query(
        {
          input: z.object({ id: z.string() }),
          output: view,
          route: { method: 'GET', path: '/_observe/api/request/:id' },
          errors: { 'observe.not-found': 404 },
          description: 'The trace a request id (`x-request-id`) — or a trace id — belongs to',
        },
        function* ({ input }) {
          const found = yield* Observe.actions.request(input.id)

          if (!found) {
            return yield* fail(ObserveErrors.NotFound, `no request ${input.id}`)
          }

          return found as AnyType
        },
      ),
      stats: action.query(
        {
          output: z.looseObject({ recorded: z.number(), dropped: z.number(), pending: z.number() }),
          route: { method: 'GET', path: '/_observe/api/stats' },
          description: 'Recorder counters of this node',
        },
        function* () {
          return (yield* Observe.actions.stats()) as AnyType
        },
      ),
      cluster: action.query(
        {
          input: z.object({ windowMs: z.number().int().min(1000).optional() }),
          output: z.looseObject({ since: z.number() }),
          route: { method: 'GET', path: '/_observe/api/cluster' },
          description: 'Members per service and per-instance span stats over a window',
        },
        function* ({ input }) {
          return (yield* Observe.actions.cluster(input.windowMs)) as AnyType
        },
      ),
      live: action.stream(
        {
          output: stream.sse(z.array(spanRow)),
          route: { method: 'GET', path: '/_observe/api/live' },
          description: 'Every batch of newly stored root spans, as they land (SSE)',
        },
        function* () {
          return Observe.actions.watch() as AnyType
        },
      ),
      manifest: action.query(
        {
          output: z.looseObject({ manifest: z.literal('ozaco/2') }),
          route: { method: 'GET', path: '/_observe/api/manifest' },
          description:
            'An ozaco/2 manifest of just this service — the console bootstraps its client from it, docs plugin or not',
        },
        function* () {
          const kernel = yield* Server.context.expect()
          const def = kernel.registry.services.get(OBSERVE_SERVICE)

          return {
            manifest: 'ozaco/2',
            name: kernel.name,
            version: kernel.version,
            instance: kernel.instance,
            services: def ? [serviceDocOf(def, [])] : [],
            errors: STATUS_OF,
            observe: { console: '/_observe' },
            docs: { path: '/_observe/api', openapi: '/docs/openapi.json' },
          } as AnyType
        },
      ),
    },
    {
      version: pkg.version,
      description: 'The observe store, over the wire',
      ...(auth === undefined ? {} : { auth }),
    },
  )
