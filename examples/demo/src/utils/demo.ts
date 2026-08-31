/** `createDemo(options)` — build (not start) one demo node: a monolith, a gateway, or a
 * service node, picked by plain options (no environment variables — each deployment shape is
 * an entrypoint under `scripts/`). */
import type { ServerDef } from 'server:core'
import { createServer, Edge } from 'server:core'
import { Auth, Cache, Cors, Docs, ObservePlugin, Resilience } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, fork } from 'std:effect'
import { isFailure } from 'std:result'

import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { OpenObserveExporter } from 'server:plugins/observe/openobserve'

import {
  ACCESS_TTL_MS,
  APP_NAME,
  APP_VERSION,
  AUTH_SECRET,
  HOSTNAME,
  READY_TIMEOUT_MS,
  services,
} from '../const'
import { authProvider } from '../internal/auth'
import { infrastructure } from '../internal/infrastructure'
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
    Auth.use({
      provider: authProvider(),
      secret: AUTH_SECRET,
      mode: 'access-refresh',
      accessTtlMs: ACCESS_TTL_MS,
    }),
    Cache,
    Resilience,
    Docs.use({ path: '/docs', title: 'ozaco demo' }),
  ]

  if (options.openobserve) {
    const target = options.openobserve

    plugins.push(
      OpenObserveExporter.use({
        url: target.url,
        org: target.org ?? 'default',
        bodies: target.bodies === true,
        // one exporter covers streams AND panels; frame/emit payloads ride the trace too
        otlp: { events: { data: target.bodies === true } },
        ...(target.auth
          ? {
              headers: {
                authorization: target.auth.includes(':')
                  ? `Basic ${btoa(target.auth)}`
                  : `Bearer ${target.auth}`,
              },
            }
          : {}),
      }),
    )
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
  })

  if (withEdge) {
    // The WebRTC signaling rooms live on the node that ACCEPTED each socket, so every edge node
    // folds the others' room events into its own view (see internal/services/rtc.ts). Failing
    // to reach the carrier must not take the node down — a single-edge deployment stays local.
    yield* fork(function* () {
      const outcome = yield* attempt(() => startRtcRelay())
      if (isFailure(outcome)) {
        console.warn(`[demo] rtc relay pump stopped: ${String(outcome.error)}`)
      }
    })

    // a route outside the action model
    yield* Edge.actions.raw({
      method: 'GET',
      path: '/',
      *handler() {
        return new Response(
          `ozaco demo · ${role} · docs at /docs · observe at /_observe · health at /_health\n`,
          { headers: { 'content-type': 'text/plain; charset=utf-8' } },
        )
      },
    })
  }

  return app
}
