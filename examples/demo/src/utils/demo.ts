/** `createDemo(options)` — build (not start) one demo node: a monolith, a gateway, or a
 * service node, picked by plain options (no environment variables — each deployment shape is
 * an entrypoint under `scripts/`). */
import type { ServerDef } from 'server:core'
import { createServer, Edge } from 'server:core'
import {
  Auth,
  Cache,
  Cors,
  Docs,
  HotReload,
  JwtAuth,
  ObservePlugin,
  Resilience,
  StaticAuth,
} from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, fork } from 'std:effect'
import { Logger } from 'std:logger'
import { isFailure } from 'std:result'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { OpenObserveExporter } from 'server:plugins/observe/openobserve'
import { OtlpExporter } from 'server:plugins/observe/otlp'

import {
  ACCESS_TTL_MS,
  APP_NAME,
  APP_VERSION,
  AUTH_SECRET,
  HOSTNAME,
  MCP_TOKEN,
  OBSERVE_TOKEN,
  OTLP_URL,
  READY_TIMEOUT_MS,
  services,
} from '../const'
import { authProvider, canObserve, OBSERVE_ROLE } from '../internal/auth'
import { infrastructure } from '../internal/infrastructure'
import { JobsWorker } from '../internal/services/jobs'
import { startRtcRelay } from '../internal/services/rtc'
import type { DemoOptions } from '../types/demo'

export function* createDemo(
  options: DemoOptions = {},
): Operation<ServerDef.Handle<typeof services>> {
  yield* infrastructure(options)
  const role = options.role ?? 'monolith'
  const withEdge = role !== 'service' || options.port !== undefined

  const plugins: ServerDef.PluginLike[] = [
    ObservePlugin.use({
      console: true,
      // `/_observe/api/*` — everything the console shows — answers admins and the ops bearer
      // only: the telemetry carries captured bodies and whole failure chains (the console page
      // itself is a public shell that asks for a bearer)
      auth: canObserve,
      cluster: {
        sendToCollector:
          options.observe === 'forward'
            ? true
            : options.observe === 'and-local'
              ? 'and-local'
              : false,
        isCollector: options.observe === 'collect',
      },
    }),
    Cors.use({ origins: '*' }),
    // two credential strategies side by side — JWTs from `account.login` and pre-shared service
    // bearers (the MCP host's for `jobs.pending`, the ops one for the observe console); the
    // first strategy that recognizes a bearer answers.
    // `Auth` is the gate over both; `default` is left open here — set `default:
    // 'authenticated'` to make a node fail-closed
    JwtAuth.use({
      provider: authProvider(),
      secret: AUTH_SECRET,
      mode: 'access-refresh',
      accessTtlMs: ACCESS_TTL_MS,
    }),
    StaticAuth.use({
      tokens: {
        [MCP_TOKEN]: { sub: 'service:mcp', type: 'service' },
        [OBSERVE_TOKEN]: { sub: 'service:observe', type: 'service', roles: [OBSERVE_ROLE] },
      },
    }),
    Auth,
    Cache,
    Resilience,
    Docs.use({ path: '/docs', title: 'ozaco demo' }),
    // the job queue's worker: its start hook runs it where `jobs` is hosted
    JobsWorker.use(),
  ]

  if (options.hot) {
    // the declarations module and the tree it imports — `src/`; a save anywhere under it swaps
    // the services in place (routes, handlers, schemas), the node keeps running
    const src = new URL('..', import.meta.url).pathname.replace(/\/$/u, '')

    plugins.push(HotReload.use({ entry: `${src}/const.ts`, watch: [src] }))
  }

  // exporters take transport options only — the content is the node's, identical in every sink
  // (the console's store, the collector, OpenObserve)
  if (options.otlp) {
    plugins.push(OtlpExporter.use({ ...options.otlp, url: options.otlp.url ?? OTLP_URL }))
  }

  if (options.openobserve) {
    plugins.push(OpenObserveExporter.use(options.openobserve))
  }

  const app = yield* createServer({
    services,
    role,
    ...(options.hosted && options.hosted.length > 0 ? { hosted: [...options.hosted] } : {}),
    edge: withEdge ? BunEdge : undefined,
    carrier: NetworkCarrier,
    plugins,
    name: APP_NAME,
    version: APP_VERSION,
    instance: options.instance,
    listen: { port: options.port ?? 0, hostname: HOSTNAME },
    readyTimeoutMs: READY_TIMEOUT_MS,
    // what the telemetry captures is decided once, for every sink alike
    ...(options.capture ? { observe: { capture: { bodies: true, frames: true } } } : {}),
  })

  if (withEdge) {
    // The WebRTC signaling rooms live on the node that ACCEPTED each socket, so every edge node
    // folds the others' room events into its own view (see internal/services/rtc.ts). Failing
    // to reach the carrier must not take the node down — a single-edge deployment stays local.
    yield* fork(function* () {
      const outcome = yield* attempt(() => startRtcRelay())
      if (isFailure(outcome)) {
        // the whole failure (chain included) rides the line — and its log record
        yield* Logger.actions.child({ logger: 'demo/rtc' }, () =>
          Logger.actions.warn('rtc relay pump stopped', outcome),
        )
      }
    })

    // a route outside the action model
    yield* Edge.actions.raw({
      method: 'GET',
      path: '/',
      *handler() {
        return new Response(
          `ozaco demo · ${role} · docs at /docs · observe at /_observe (admin / ops bearer) · health at /_health\n`,
          { headers: { 'content-type': 'text/plain; charset=utf-8' } },
        )
      },
    })
  }

  return app
}
