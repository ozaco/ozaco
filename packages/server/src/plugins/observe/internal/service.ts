import { action, Observe, Server, service, STATUS_OF, stream } from 'server:core'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import pkg from '../../../../package.json'
import { serviceDocOf } from '../../docs/internal/manifest'
import { ObserveErrors } from '../errors'

/** Rows come straight from the store: assert the key, pass the rest through. */
const requestRow = z.looseObject({ request_id: z.string() })

const page = z.object({
  requests: z.array(requestRow),
  cursor: z.string().nullable(),
})

const view = z.looseObject({
  request: requestRow,
  spans: z.array(z.looseObject({})),
  logs: z.array(z.looseObject({})),
  failures: z.array(z.looseObject({})),
  events: z.array(z.looseObject({})),
})

const query = z.object({
  service: z.string().optional(),
  action: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(['ok', 'failed']).optional(),
  slowerThan: z.number().optional(),
  since: z.number().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
})

/**
 * The observe API as a REAL service: the console (and any `@ozaco/client`) reaches the store
 * through the manifest — typed, documented, SSE for the live feed. Mounted under
 * `/_observe/api/*`; registered by the plugin on every node it is installed on (local only,
 * never served over the carrier).
 */
export const observeService = service(
  'observe',
  {
    requests: action.query(
      {
        input: query,
        output: page,
        route: { method: 'GET', path: '/_observe/api/requests' },
        description: 'Finished requests, newest first — cursor-paged',
      },
      function* ({ input }) {
        return (yield* Observe.actions.query(input)) as AnyType
      },
    ),
    request: action.query(
      {
        input: z.object({ id: z.string() }),
        output: view,
        route: { method: 'GET', path: '/_observe/api/request/:id' },
        errors: { 'observe.not-found': 404 },
        description: 'One request with its spans, logs, failures and events',
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
        output: stream.sse(z.array(requestRow)),
        route: { method: 'GET', path: '/_observe/api/live' },
        description: 'Every batch of newly finished requests, as they land (SSE)',
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
        const def = kernel.registry.services.get('observe')

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
  { version: pkg.version, description: 'The observe store, over the wire' },
)
