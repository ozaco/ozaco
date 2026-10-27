import type { EdgeDef, ServerDef } from 'server:core'
import { Edge, Server, ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, until } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { asFailure, fail, isFailure } from 'std:result'
import { Ws, WsClient } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'

import pkg from '../../../package.json'

import type { ProxyDef } from './types'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const

/** Headers that belong to ONE hop and must not be forwarded. */
const HOP_BY_HOP = [
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
]

const configOf = (options: ProxyDef.Options): ProxyDef.Config => ({
  prefix: options.prefix.replace(/\/+$/u, ''),
  target: new URL(options.target),
  ws: options.ws ?? true,
  headers: options.headers ?? {},
})

/** The upstream url of a request under the prefix: the path with the prefix stripped, the query kept. */
const upstreamOf = (config: ProxyDef.Config, incoming: URL, scheme?: string): URL => {
  const url = new URL(config.target)
  const path = incoming.pathname.startsWith(config.prefix)
    ? incoming.pathname.slice(config.prefix.length)
    : incoming.pathname

  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path.startsWith('/') ? path : `/${path}`}`
  url.search = incoming.search

  if (scheme) {
    url.protocol = scheme
  }

  return url
}

const forwardedHeaders = (config: ProxyDef.Config, request: Request): Headers => {
  const headers = new Headers(request.headers)

  for (const name of HOP_BY_HOP) {
    headers.delete(name)
  }

  headers.set('x-forwarded-host', new URL(request.url).host)
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''))

  for (const [name, value] of Object.entries(config.headers)) {
    headers.set(name, value)
  }

  return headers
}

/** One HTTP request forwarded upstream, its reply streamed back as is. */
function* forward(config: ProxyDef.Config, request: Request): Operation<Response> {
  const incoming = new URL(request.url)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const reply = yield* attempt(() =>
    until(
      fetch(upstreamOf(config, incoming), {
        method: request.method,
        headers: forwardedHeaders(config, request),
        body: hasBody ? request.body : undefined,
        redirect: 'manual',
        duplex: 'half',
      } as RequestInit),
    ),
  )

  if (isFailure(reply)) {
    return yield* fail(
      ServerErrors.Unavailable,
      `proxy: ${config.target.origin} did not answer`,
      asFailure(reply),
    )
  }

  const headers = new Headers(reply.value.headers)

  for (const name of HOP_BY_HOP) {
    headers.delete(name)
  }

  return new Response(reply.value.body, {
    status: reply.value.status,
    statusText: reply.value.statusText,
    headers,
  })
}

/** One socket under the prefix bridged to the upstream's: frames both ways until either side ends. */
function* bridge(
  config: ProxyDef.Config,
  socket: EdgeDef.Socket<unknown, unknown>,
): Operation<void> {
  const scheme = config.target.protocol === 'https:' ? 'wss:' : 'ws:'
  const upstream = yield* Ws.actions.connect(upstreamOf(config, socket.url, scheme), {
    headers: Object.fromEntries(
      Object.entries(socket.headers).filter(([name]) => name === 'authorization'),
    ),
  })

  // upstream → client
  yield* fork(function* () {
    const feed = yield* upstream.messages

    for (;;) {
      const step = yield* feed.next()

      if (step.done) {
        yield* socket.close(1000, 'upstream closed')

        return
      }

      yield* socket.send(step.value)
    }
  })

  // client → upstream: the handler's own loop; its end ends the bridge
  const feed = yield* socket.messages

  for (;;) {
    const step = yield* feed.next()

    if (step.done) {
      yield* upstream.close(1000, 'client closed')

      return
    }

    yield* upstream.send(step.value)
  }
}

/**
 * A reverse proxy under a path prefix — the dev server's `/api` → the node, or a gateway that
 * fronts another node — over the edge's raw routes: every method under `<prefix>/**` is forwarded
 * to `<target>/<rest>` (query kept, hop-by-hop headers dropped, `x-forwarded-host` / `-proto`
 * set, the reply streamed back), and with `ws` (default on) a WebSocket upgrade under the prefix
 * is bridged to the upstream's socket frame by frame. An upstream that does not answer is
 * `server.unavailable` (503). Public (`auth: false`): the upstream gates its own routes. Pair it
 * with `Edge.actions.static` for a single-origin front end. Needs an edge.
 */
export const Proxy = definePlugin<ServerDef.PluginContext, [options: ProxyDef.Options]>({
  name: 'server-proxy',
  version: pkg.version,
  description: 'Forward a path prefix (HTTP and WebSocket) to another origin',

  *setup(options) {
    if (!(yield* Server.context.get())) {
      return yield* fail(
        ServerErrors.Configuration,
        'Proxy must be installed by Server.actions.create',
      )
    }

    const config = configOf(options)

    if (config.ws) {
      // the bridge dials upstream sockets through std:ws — give the scope a client when it has none
      yield* attempt(() => JsonCodec.use())

      if (!(yield* Ws.context.get())) {
        yield* WsClient.use()
      }
    }

    return {
      hooks: {
        name: 'proxy',
        *start() {
          for (const method of METHODS) {
            yield* Edge.actions.raw({
              method,
              path: `${config.prefix}/**`,
              auth: false,
              observe: 'errors',
              handler: request => forward(config, request),
            })
          }

          if (config.ws) {
            yield* Edge.actions.socket({
              path: `${config.prefix}/**`,
              description: `bridged to ${config.target.origin}`,
              handler: socket => bridge(config, socket),
            })
          }
        },
      },
    }
  },
}).build()
